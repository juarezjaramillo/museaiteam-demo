#!/usr/bin/env node
// Generates shopify-products.csv and hubspot-tickets.csv from products.json.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_BASE =
  "https://raw.githubusercontent.com/juarezjaramillo/museaiteam-demo/main/demo/coffee-store/";

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvRow(cells) {
  return cells.map(csvCell).join(",") + "\n";
}

const products = JSON.parse(
  readFileSync(join(HERE, "products.json"), "utf8")
).products;

// --- Shopify products import ---
const shopifyHeader = [
  "Handle",
  "Title",
  "Body (HTML)",
  "Vendor",
  "Type",
  "Tags",
  "Published",
  "Option1 Name",
  "Option1 Value",
  "Variant SKU",
  "Variant Grams",
  "Variant Inventory Tracker",
  "Variant Inventory Qty",
  "Variant Inventory Policy",
  "Variant Fulfillment Service",
  "Variant Price",
  "Variant Requires Shipping",
  "Variant Taxable",
  "Image Src",
  "Image Position",
  "Image Alt Text",
  "Status",
];
let shopify = csvRow(shopifyHeader);
for (const p of products) {
  shopify += csvRow([
    p.handle,
    p.title,
    p.description,
    "Tres Cumbres Coffee Co.",
    "Coffee",
    p.tags.join(", "),
    "TRUE",
    "Title",
    "Default Title",
    p.sku,
    p.grams,
    "shopify",
    p.inventory,
    "deny",
    "manual",
    p.price.toFixed(2),
    "TRUE",
    "TRUE",
    RAW_BASE + p.image_file,
    1,
    p.image_alt,
    "active",
  ]);
}
writeFileSync(join(HERE, "shopify-products.csv"), shopify);

// --- HubSpot tickets import ---
const tickets = [
  {
    name: "Will my Black Friday order arrive before Dec 20?",
    description:
      "Hi, I want to order several bags as Christmas gifts during your Black Friday sale on Nov 27. " +
      "I need them to arrive before Dec 20. Can you tell me if that will work with standard shipping? " +
      "I live in Texas. Thanks!",
    priority: "HIGH",
  },
  {
    name: "Do you ship to Canada?",
    description:
      "Hello, I live in Toronto and I would love to try your Oaxaca Pluma. " +
      "Do you ship to Canada, and if so, how much does shipping cost? Thank you!",
    priority: "MEDIUM",
  },
  {
    name: "Can I add a gift note to the gift box?",
    description:
      "I am sending the Tres Cumbres Gift Box to my dad for his birthday. " +
      "Is it possible to add a short gift note inside the box? " +
      "Just two or three lines would be perfect.",
    priority: "MEDIUM",
  },
  {
    name: "Is Oaxaca Pluma available ground?",
    description:
      "Hi, I do not have a grinder at home right now. " +
      "Is the Oaxaca Pluma available as ground coffee instead of whole bean? " +
      "I brew with a drip machine.",
    priority: "LOW",
  },
  {
    name: "My discount code did not work",
    description:
      "Hi, I tried to use a discount code last week and it did not work at checkout. " +
      "I am not sure what went wrong. " +
      "Also, will there be a Black Friday deal I should wait for instead?",
    priority: "MEDIUM",
  },
  {
    name: "Envío a Monterrey y pago en pesos",
    description:
      "Hola, vivo en Monterrey y quiero pedir dos bolsas de café. " +
      "¿Hacen envíos a Monterrey? ¿Cuánto tarda en llegar y cuánto cuesta el envío? " +
      "Y otra pregunta: ¿puedo pagar en pesos o solo en dólares? Gracias.",
    priority: "MEDIUM",
  },
];
let hubspot = csvRow([
  "Ticket name",
  "Ticket description",
  "Pipeline",
  "Ticket status",
  "Priority",
  "Source",
]);
for (const t of tickets) {
  hubspot += csvRow([
    t.name,
    t.description,
    "Support Pipeline",
    "New",
    t.priority,
    "Email",
  ]);
}
writeFileSync(join(HERE, "hubspot-tickets.csv"), hubspot);

console.log(
  `Wrote shopify-products.csv (${products.length} products) and hubspot-tickets.csv (${tickets.length} tickets).`
);
