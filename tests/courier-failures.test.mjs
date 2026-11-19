// #1150: Gophr refused the job (422) on every attempt; the app retried for
// thirty minutes, then left a note that said only "Gophr returned 422..".
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMobile,
  riderPhone,
  gophrReason,
  failureNote,
  retryVerdict,
} from "../app/lib/courier-booking.js";

const SHOP = "07700 900123";

test("a US number goes to the note and the rider gets the shop's", () => {
  const p = riderPhone({ mobile: "+13392261141", shopMobile: SHOP });
  assert.equal(p.mobile, "+447700900123");
  assert.equal(p.note, "Customer's phone: +13392261141");
});

test("a UK number goes through untouched", () => {
  assert.deepEqual(riderPhone({ mobile: "07873 989675", shopMobile: SHOP }), {
    mobile: "+447873989675",
    note: null,
  });
});

test("no number stays no number", () => {
  assert.deepEqual(riderPhone({ mobile: "", shopMobile: SHOP }), { mobile: "", note: null });
});

test("without a shop number the customer's is sent as before", () => {
  assert.deepEqual(riderPhone({ mobile: "+13392261141", shopMobile: "" }), {
    mobile: "+13392261141",
    note: null,
  });
});

test("a UK mobile missing its 0 is recognised (#1141)", () => {
  assert.equal(normalizeMobile("7985965716"), "+447985965716");
  assert.equal(riderPhone({ mobile: "7985965716", shopMobile: SHOP }).note, null);
});

test("a 422 is final at once, even a minute after payment", () => {
  const v = retryVerdict({
    paidAt: "2026-11-18T08:59:31Z",
    now: new Date("2026-11-18T09:00:31Z"),
    status: 422,
  });
  assert.equal(v.retry, false);
  assert.equal(v.reason, "rejected");
});

test("a 500, a timeout or a 429 inside the window is still retried", () => {
  const args = { paidAt: "2026-11-18T08:59:31Z", now: new Date("2026-11-18T09:00:31Z") };
  assert.equal(retryVerdict({ ...args, status: 500 }).retry, true);
  assert.equal(retryVerdict({ ...args, status: 429 }).retry, true);
  assert.equal(retryVerdict({ ...args, status: 408 }).retry, true);
  assert.equal(retryVerdict({ ...args }).retry, true);
});

test("Gophr's reason is read out of its error body", () => {
  const body = { errors: [{ object: "dropoff_mobile_number", message: "Invalid mobile number" }] };
  assert.equal(gophrReason(body), "dropoff_mobile_number: Invalid mobile number");
});

test("an unfamiliar body is kept as JSON rather than lost", () => {
  assert.equal(gophrReason({ weird: 1 }), '{"weird":1}');
  assert.equal(gophrReason(null), "");
});

test("the note carries the reason and no double full stop", () => {
  const error = {
    message: "Gophr returned 422.",
    body: { errors: [{ object: "dropoff_mobile_number", message: "Invalid mobile number" }] },
  };
  assert.equal(
    failureNote(error),
    "The courier booking failed: Gophr returned 422 (dropoff_mobile_number: Invalid mobile number). Book by hand and contact the customer."
  );
  assert.equal(
    failureNote({ message: "Gophr returned 422." }),
    "The courier booking failed: Gophr returned 422. Book by hand and contact the customer."
  );
});
