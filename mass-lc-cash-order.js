#!/usr/bin/env node

import fs from "fs";
import csv from "csv-parser";
import progress from "cli-progress";
import fetch from "node-fetch";

// CONFIG HERE

const CONFIG = {
  firstName: 'Nathaniel',
  lastName: 'Higgers',
  email: 'cpninfo2006@gmail.com',
  phone: '248-434-5508', // MUST be a real number, as they may call

  cheapItems: [
    // adjust based on menu codes
    { code: "CLASSIC_PEPPERONI_LG", qty: 1 }
  ],

  maxTotalDollars: 35.00,

  delayBetweenOrdersMs: 10000,

  inputFile: "addresses.csv",
  logFile: "lc-order-log.json"
};

//helpers

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay(min, max) {
  return sleep(min + Math.random() * (max - min));
}

function randomUserAgent() {
  const agents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (Linux; Android 12; SM-G991U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

async function lcFetch(url, method = "GET", body = null, session = null) {
  const headers = {
    "User-Agent": randomUserAgent(),
    "Content-Type": "application/json",
    "X-LC-Channel": "WEB",
    "X-LC-Locale": "en-US"
  };

  if (session?.sessionId) headers["X-LC-Session-ID"] = session.sessionId;
  if (session?.cartId) headers["X-LC-Cart-ID"] = session.cartId;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return text; }
}

// der API logic

async function createSession() {
  return lcFetch(
    "https://orderapi.littlecaesars.com/v4/sessions",
    "POST",
    { channel: "WEB", locale: "en-US" }
  );
}

async function searchStores(address) {
  return lcFetch(
    "https://orderapi.littlecaesars.com/v4/stores/search",
    "POST",
    { address }
  );
}

async function getMenu(storeId, session) {
  return lcFetch(
    `https://orderapi.littlecaesars.com/v4/stores/${storeId}/menu`,
    "GET",
    null,
    session
  );
}

async function addItem(storeId, cartId, productCode, qty, session) {
  return lcFetch(
    `https://orderapi.littlecaesars.com/v4/carts/${cartId}/items`,
    "POST",
    {
      storeId,
      productCode,
      quantity: qty,
      options: []
    },
    session
  );
}

async function updateCustomer(cartId, customer, session) {
  return lcFetch(
    `https://orderapi.littlecaesars.com/v4/carts/${cartId}`,
    "PATCH",
    { customer },
    session
  );
}

async function setDelivery(cartId, addr, session) {
  return lcFetch(
    `https://orderapi.littlecaesars.com/v4/carts/${cartId}`,
    "PATCH",
    {
      fulfillmentMethod: "DELIVERY",
      address: addr
    },
    session
  );
}

async function setCashPayment(cartId, session) {
  return lcFetch(
    `https://orderapi.littlecaesars.com/v4/carts/${cartId}/payments`,
    "PATCH",
    { payments: [{ type: "CASH", amount: 0 }] },
    session
  );
}

async function placeOrder(cartId, session) {
  return lcFetch(
    "https://orderapi.littlecaesars.com/v4/orders",
    "POST",
    { cartId },
    session
  );
}

// processing each address

const results = [];

async function processAddress(row) {
  const fullAddress = `${row.street}, ${row.city}, ${row.region} ${row.postalCode}`;

  try {
    const session = await createSession();

    const finding = await searchStores(fullAddress);
    const store = (finding?.stores || []).find(s => s.isOpen && s.supportsDelivery);

    if (!store) throw new Error("No delivery store available");

    const storeId = store.storeId;

    for (const item of CONFIG.cheapItems) {
      await addItem(storeId, session.cartId, item.code, item.qty, session);
      await sleep(500);
    }

    await updateCustomer(session.cartId, {
      firstName: row.firstName || CONFIG.firstName,
      lastName: row.lastName || CONFIG.lastName,
      email: row.email || CONFIG.email,
      phoneNumber: row.phone || CONFIG.phone
    }, session);

    await setDelivery(session.cartId, {
      street: row.street,
      city: row.city,
      state: row.region,
      postalCode: row.postalCode
    }, session);

    await setCashPayment(session.cartId, session);

    const final = await placeOrder(session.cartId, session);

    if (!final?.orderId) throw new Error("Order placement failed");

    results.push({
      address: fullAddress,
      storeId,
      orderId: final.orderId,
      status: "SUCCESS",
      time: new Date().toISOString()
    });

    console.log(`SUCCESS: → ${fullAddress} | Order ${final.orderId}`);

  } catch (err) {
    results.push({
      address: fullAddress,
      status: "FAILED",
      error: err.message,
      time: new Date().toISOString()
    });

    console.log(`FAILED: ${fullAddress} — ${err.message}`);
  }
}

//main o algo

async function main() {
  console.log("THE 'ZANNON!\n");

  const addresses = [];
  await new Promise((res, rej) => {
    fs.createReadStream(CONFIG.inputFile)
      .pipe(csv())
      .on("data", d => addresses.push(d))
      .on("end", res)
      .on("error", rej);
  });

  if (addresses.length === 0) {
    console.log("No addresses found.");
    return;
  }

  const bar = new progress.SingleBar({}, progress.Presets.shades_classic);
  bar.start(addresses.length, 0);

  for (let i = 0; i < addresses.length; i++) {
    await processAddress(addresses[i]);
    bar.update(i + 1);

    if (i < addresses.length - 1)
      await randomDelay(CONFIG.delayBetweenOrdersMs, CONFIG.delayBetweenOrdersMs * 3);
  }

  bar.stop();
  fs.writeFileSync(CONFIG.logFile, JSON.stringify(results, null, 2));

  console.log(`\nDone. Results saved to ${CONFIG.logFile}`);
}

main();
