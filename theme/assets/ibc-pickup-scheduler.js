/* Italian Bear Chocolate — cart pickup scheduler (pickup-only).
 *
 * - Availability rules are computed server-side via the app proxy
 *   (/apps/ibc-pickup/availability). No business logic or credentials here.
 * - The chosen slot is stored as ibc_pickup_* cart attributes through the
 *   Cart Ajax API, so it lands on the Shopify order.
 * - The scheduler is optional and never touches Shopify checkout's native
 *   fulfilment selection: customers must still choose "Pick up" at checkout.
 * - Re-initialises safely after Dawn cart updates and section re-renders:
 *   a custom element self-initialises whenever it (re)enters the DOM, and a
 *   fetch listener re-validates after any Cart Ajax mutation.
 */
(function () {
  'use strict';

  if (customElements.get('ibc-pickup-scheduler')) return;

  var ATTRIBUTE_KEYS = [
    'ibc_pickup_requested',
    'ibc_pickup_date',
    'ibc_pickup_slot_start',
    'ibc_pickup_slot_end',
    'ibc_pickup_slot_label',
    'ibc_pickup_delay_minutes',
    'ibc_pickup_location'
  ];

  var CART_MUTATION_PATTERN = /\/cart\/(add|update|change|clear)(\.js)?(\?|$)/;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMoney(pence, currency) {
    try {
      return new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: currency || 'GBP'
      }).format(pence / 100);
    } catch (e) {
      return '£' + (pence / 100).toFixed(2);
    }
  }

  /* Notify all live schedulers after any Cart Ajax mutation (quantity
     changes, additions, removals — including Dawn's own requests). */
  if (!window.__ibcCartFetchPatched) {
    window.__ibcCartFetchPatched = true;
    var ibcOriginalFetch = window.fetch;
    window.fetch = function () {
      var url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url) || '';
      var result = ibcOriginalFetch.apply(this, arguments);
      if (CART_MUTATION_PATTERN.test(url)) {
        result.then(function (response) {
          if (response && response.ok) {
            window.dispatchEvent(new CustomEvent('ibc:cart-changed'));
          }
          return response;
        }).catch(function () {});
      }
      return result;
    };
  }

  var IbcPickupScheduler = /** @class */ (function () {
    function define() {
      class Scheduler extends HTMLElement {
        connectedCallback() {
          this.root = this.querySelector('[data-ibc-root]');
          if (!this.root) return;
          this.proxyUrl = this.getAttribute('data-proxy-url') || '/apps/ibc-pickup/availability';
          this.availability = null;
          this.cart = this.readEmbeddedCart();
          this.view = 'idle';
          this.selectedDate = null;
          this.selection = null;
          this.notice = '';
          this.busy = false;
          this.refreshTimer = null;

          this.onCartChanged = this.scheduleRefresh.bind(this);
          window.addEventListener('ibc:cart-changed', this.onCartChanged);

          // Dawn pub/sub, when available, catches cart updates made via XHR.
          if (typeof window.subscribe === 'function' && window.PUB_SUB_EVENTS && window.PUB_SUB_EVENTS.cartUpdate) {
            try {
              this.unsubscribeCart = window.subscribe(window.PUB_SUB_EVENTS.cartUpdate, this.onCartChanged);
            } catch (e) { /* non-fatal */ }
          }

          this.initialise();
        }

        disconnectedCallback() {
          window.removeEventListener('ibc:cart-changed', this.onCartChanged);
          if (typeof this.unsubscribeCart === 'function') this.unsubscribeCart();
          if (this.refreshTimer) clearTimeout(this.refreshTimer);
        }

        readEmbeddedCart() {
          var el = this.querySelector('[data-ibc-cart]');
          try {
            return JSON.parse(el.textContent);
          } catch (e) {
            return { total_price: 0, currency: 'GBP', item_count: 0, items: [], attributes: {} };
          }
        }

        /* ---------- data ---------- */

        fetchCart() {
          var self = this;
          return fetch('/cart.js', { headers: { Accept: 'application/json' } })
            .then(function (r) { return r.json(); })
            .then(function (cart) {
              self.cart = {
                total_price: cart.total_price,
                currency: cart.currency,
                item_count: cart.item_count,
                items: cart.items.map(function (i) {
                  return { product_id: i.product_id, quantity: i.quantity };
                }),
                attributes: cart.attributes || {}
              };
              return self.cart;
            });
        }

        fetchAvailability() {
          var self = this;
          return fetch(this.proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              items: (this.cart.items || []).map(function (i) {
                return { product_id: i.product_id, quantity: i.quantity };
              }),
              total_price: this.cart.total_price
            })
          }).then(function (r) {
            if (!r.ok) throw new Error('availability_failed');
            return r.json();
          }).then(function (availability) {
            self.availability = availability;
            return availability;
          });
        }

        findSlot(dateStr, slotStartIso) {
          if (!this.availability || !this.availability.dates) return null;
          for (var d = 0; d < this.availability.dates.length; d += 1) {
            var day = this.availability.dates[d];
            if (day.date !== dateStr) continue;
            for (var s = 0; s < day.slots.length; s += 1) {
              if (day.slots[s].start_iso === slotStartIso) {
                return { day: day, slot: day.slots[s] };
              }
            }
          }
          return null;
        }

        /* ---------- lifecycle ---------- */

        initialise() {
          var self = this;
          if (!this.cart.item_count) { this.root.hidden = true; return; }
          this.root.hidden = false;
          this.renderLoading();
          this.fetchAvailability()
            .then(function () { self.applyAvailability(true); })
            .catch(function () { self.renderError(); });
        }

        scheduleRefresh() {
          var self = this;
          if (this.refreshTimer) clearTimeout(this.refreshTimer);
          this.refreshTimer = setTimeout(function () { self.refresh(); }, 250);
        }

        refresh() {
          var self = this;
          this.fetchCart()
            .then(function () {
              if (!self.cart.item_count) { self.root.hidden = true; return null; }
              self.root.hidden = false;
              return self.fetchAvailability().then(function () {
                self.applyAvailability(false);
              });
            })
            .catch(function () { /* keep the current view on transient errors */ });
        }

        /* Decide which view to show, re-validating any stored selection
           against fresh server-side availability. */
        applyAvailability(isFirstLoad) {
          var a = this.availability;
          var attrs = this.cart.attributes || {};
          var hasStored = String(attrs.ibc_pickup_requested) === 'true' && attrs.ibc_pickup_slot_start;

          if (!a.eligible) {
            if (hasStored) {
              // Selection no longer allowed (item not collectable / below minimum).
              this.clearAttributes(true);
              return;
            }
            this.selection = null;
            this.renderBlocked(a.reason);
            return;
          }

          if (hasStored) {
            var match = this.findSlot(attrs.ibc_pickup_date, attrs.ibc_pickup_slot_start);
            var storedDelay = String(attrs.ibc_pickup_delay_minutes || '');
            var delayChanged = storedDelay !== String(a.max_delay_minutes);
            if (match && !delayChanged) {
              this.selection = {
                date: attrs.ibc_pickup_date,
                slot: match.slot,
                label: attrs.ibc_pickup_slot_label || match.slot.label
              };
              this.renderSelected();
              return;
            }
            // Stale or invalid — never leave an invalid time visibly selected.
            this.clearAttributes(true);
            return;
          }

          this.selection = null;
          if (isFirstLoad || this.view === 'idle' || this.view === 'blocked') {
            this.renderIdle();
          } else {
            this.renderPicker();
          }
        }

        /* ---------- cart attribute writes ---------- */

        writeAttributes(attributes) {
          return fetch('/cart/update.js', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ attributes: attributes })
          }).then(function (r) {
            if (!r.ok) throw new Error('cart_update_failed');
            return r.json();
          });
        }

        selectSlot(day, slot) {
          var self = this;
          if (this.busy) return;
          this.busy = true;
          this.renderLoading('Saving your collection time…');
          var attributes = {
            ibc_pickup_requested: 'true',
            ibc_pickup_date: day.date,
            ibc_pickup_slot_start: slot.start_iso,
            ibc_pickup_slot_end: slot.end_iso,
            ibc_pickup_slot_label: slot.label,
            ibc_pickup_delay_minutes: String(this.availability.max_delay_minutes),
            ibc_pickup_location: this.availability.location || ''
          };
          this.writeAttributes(attributes)
            .then(function (cart) {
              // Confirm the update really landed before showing a selected state.
              var saved = cart.attributes || {};
              if (String(saved.ibc_pickup_slot_start) !== slot.start_iso) {
                throw new Error('cart_attributes_mismatch');
              }
              self.cart.attributes = saved;
              self.selection = { date: day.date, slot: slot, label: slot.label };
              self.busy = false;
              self.renderSelected();
            })
            .catch(function () {
              self.busy = false;
              self.notice = 'Sorry, we could not save your collection time. Please try again.';
              self.renderPicker();
            });
        }

        clearAttributes(becauseInvalid) {
          var self = this;
          var cleared = {};
          ATTRIBUTE_KEYS.forEach(function (key) { cleared[key] = ''; });
          return this.writeAttributes(cleared)
            .then(function (cart) {
              self.cart.attributes = cart.attributes || {};
              self.selection = null;
              if (becauseInvalid) {
                self.notice = 'Your selected collection time is no longer available with the items in your basket. Please choose a new time.';
                if (self.availability && self.availability.eligible) {
                  self.renderPicker();
                } else {
                  self.renderBlocked(self.availability ? self.availability.reason : null);
                }
              } else {
                self.notice = '';
                self.renderIdle();
              }
            })
            .catch(function () {
              self.notice = 'Sorry, we could not update your basket. Please try again.';
              self.renderSelected();
            });
        }

        /* ---------- views ---------- */

        setHtml(html) {
          this.root.innerHTML = html;
        }

        noticeHtml() {
          if (!this.notice) return '';
          var html =
            '<p class="ibc-pickup__status ibc-pickup__status--warning" role="status">' +
            escapeHtml(this.notice) +
            '</p>';
          this.notice = '';
          return html;
        }

        renderLoading(message) {
          this.view = 'loading';
          this.setHtml(
            '<p class="ibc-pickup__spinner" role="status" aria-live="polite">' +
            escapeHtml(message || 'Checking collection times…') +
            '</p>'
          );
        }

        renderError() {
          this.view = 'error';
          this.setHtml(
            '<h3 class="ibc-pickup__heading">Collecting from store?</h3>' +
            '<p class="ibc-pickup__copy">Collection times are unavailable right now. ' +
            'You can still check out and choose Pick up at checkout.</p>'
          );
        }

        renderBlocked(reason) {
          this.view = 'blocked';
          var message;
          if (reason === 'products_unavailable') {
            message = 'One or more items in your basket are not available for collection.';
          } else if (reason === 'below_minimum') {
            message =
              'Collection is available for orders over ' +
              formatMoney(this.availability.minimum_value_pence || 0, this.cart.currency) +
              '.';
          } else {
            message = 'Collection is not available at the moment.';
          }
          this.setHtml(
            this.noticeHtml() +
            '<h3 class="ibc-pickup__heading">Collecting from store?</h3>' +
            '<p class="ibc-pickup__status" role="status">' + escapeHtml(message) + '</p>'
          );
        }

        renderIdle() {
          this.view = 'idle';
          this.setHtml(
            this.noticeHtml() +
            '<h3 class="ibc-pickup__heading">Collecting from store?</h3>' +
            '<p class="ibc-pickup__copy">Choose a collection time before checkout.</p>' +
            '<button type="button" class="ibc-pickup__button" data-ibc-action="open">Choose collection time</button>'
          );
          this.bind();
        }

        renderPicker() {
          this.view = 'picker';
          var a = this.availability;
          if (!a || !a.eligible) { this.renderBlocked(a && a.reason); return; }
          if (!a.dates.length) {
            this.setHtml(
              this.noticeHtml() +
              '<h3 class="ibc-pickup__heading">Choose your collection time</h3>' +
              '<p class="ibc-pickup__status" role="status">No collection times are currently available. Please check back soon.</p>'
            );
            return;
          }

          if (!this.selectedDate || !a.dates.some(function (d) { return d.date === this.selectedDate; }, this)) {
            this.selectedDate = a.dates[0].date;
          }
          var selectedDay = a.dates.filter(function (d) { return d.date === this.selectedDate; }, this)[0];

          var datesHtml = a.dates.map(function (d) {
            var parts = d.date_label.split(' '); // "Saturday 11 July"
            var checked = d.date === this.selectedDate ? 'true' : 'false';
            return (
              '<li>' +
              '<button type="button" role="radio" aria-checked="' + checked + '" class="ibc-pickup__option" ' +
              'data-ibc-date="' + escapeHtml(d.date) + '">' +
              '<span class="ibc-pickup__option-day">' + escapeHtml(parts[0]) + '</span>' +
              escapeHtml(parts.slice(1).join(' ')) +
              '</button></li>'
            );
          }, this).join('');

          var slotsHtml = selectedDay.slots.map(function (s) {
            return (
              '<li>' +
              '<button type="button" role="radio" aria-checked="false" class="ibc-pickup__option" ' +
              'data-ibc-slot="' + escapeHtml(s.start_iso) + '">' +
              escapeHtml(s.time_label) +
              '</button></li>'
            );
          }).join('');

          var locationHtml = '';
          if (a.location) {
            locationHtml =
              '<p class="ibc-pickup__location">' +
              '<strong>' + escapeHtml(a.location) + '</strong>' +
              (a.instructions ? '<br>' + escapeHtml(a.instructions) : '') +
              '</p>';
          }

          this.setHtml(
            this.noticeHtml() +
            '<h3 class="ibc-pickup__heading">Choose your collection time</h3>' +
            '<span class="ibc-pickup__group-label" id="ibc-date-label">Collection date</span>' +
            '<ul class="ibc-pickup__dates" role="radiogroup" aria-labelledby="ibc-date-label">' + datesHtml + '</ul>' +
            '<span class="ibc-pickup__group-label" id="ibc-slot-label">Collection time</span>' +
            '<ul class="ibc-pickup__slots" role="radiogroup" aria-labelledby="ibc-slot-label">' + slotsHtml + '</ul>' +
            locationHtml +
            '<div class="ibc-pickup__actions">' +
            '<button type="button" class="ibc-pickup__link" data-ibc-action="close">Cancel</button>' +
            '</div>'
          );
          this.bind();
        }

        renderSelected() {
          this.view = 'selected';
          var a = this.availability || {};
          var sel = this.selection;
          if (!sel) { this.renderIdle(); return; }
          var locationHtml = '';
          if (a.location) {
            locationHtml =
              '<p class="ibc-pickup__location">' +
              '<strong>' + escapeHtml(a.location) + '</strong>' +
              (a.instructions ? '<br>' + escapeHtml(a.instructions) : '') +
              '</p>';
          }
          this.setHtml(
            this.noticeHtml() +
            '<h3 class="ibc-pickup__heading">Collecting from store</h3>' +
            '<p class="ibc-pickup__selected" role="status">Collection selected for <strong>' +
            escapeHtml(sel.label) +
            '</strong></p>' +
            locationHtml +
            '<p class="ibc-pickup__checkout-reminder">' +
            escapeHtml(a.checkout_message ||
              'At checkout, please select Pick up to confirm your collection time. ' +
              'If you select Delivery instead, this collection time will not apply.') +
            '</p>' +
            '<div class="ibc-pickup__actions">' +
            '<button type="button" class="ibc-pickup__link" data-ibc-action="change">Change collection time</button>' +
            '<button type="button" class="ibc-pickup__link" data-ibc-action="clear">Clear collection time</button>' +
            '</div>'
          );
          this.bind();
        }

        /* ---------- events ---------- */

        bind() {
          var self = this;

          this.root.querySelectorAll('[data-ibc-action]').forEach(function (button) {
            button.addEventListener('click', function () {
              var action = button.getAttribute('data-ibc-action');
              if (action === 'open' || action === 'change') self.renderPicker();
              if (action === 'close') self.renderIdle();
              if (action === 'clear') {
                self.renderLoading('Clearing your collection time…');
                self.clearAttributes(false);
              }
            });
          });

          this.root.querySelectorAll('[data-ibc-date]').forEach(function (button) {
            button.addEventListener('click', function () {
              self.selectedDate = button.getAttribute('data-ibc-date');
              self.renderPicker();
            });
          });

          this.root.querySelectorAll('[data-ibc-slot]').forEach(function (button) {
            button.addEventListener('click', function () {
              button.setAttribute('aria-checked', 'true');
              var startIso = button.getAttribute('data-ibc-slot');
              var match = self.findSlot(self.selectedDate, startIso);
              if (match) self.selectSlot(match.day, match.slot);
            });
          });
        }
      }
      return Scheduler;
    }
    return define();
  })();

  customElements.define('ibc-pickup-scheduler', IbcPickupScheduler);
})();
