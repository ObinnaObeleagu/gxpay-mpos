'use strict';

/**
 * Seeds the catalog with 100 sample sale items and services - a realistic,
 * varied mix for testing/demo purposes. Works against whichever backend
 * the running server is using (in-memory or Supabase - see
 * store/catalogStore.js) since it just calls the same POST /api/catalog
 * endpoint the Items tab itself uses. No direct database access needed,
 * which also means it naturally exercises the same validation
 * (routes/catalog.js) either backend goes through.
 *
 * Usage:
 *   node scripts/seed-catalog.js                       # against http://localhost:3000
 *   BASE_URL=https://your-app.onrender.com node scripts/seed-catalog.js
 *
 * Safe to re-run - POST /api/catalog always creates a new row (there's no
 * duplicate-name check), so running this twice will create 200 items, not
 * an error. If you want a clean slate first, delete existing items via the
 * Items tab's Delete button, or truncate catalog_items directly in
 * Supabase if you're using that backend.
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const ITEMS = [
  {
    "name": "Videography (full event)",
    "price": 200000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Electrician callout fee",
    "price": 5000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Makeup and gele service",
    "price": 20000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Catering service (per 50 guests)",
    "price": 250000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Private tutoring (per hour)",
    "price": 5000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Painting service (per room)",
    "price": 20000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Bluetooth earbuds",
    "price": 15000,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "LED bulb (9W)",
    "price": 1200,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "USB flash drive (32GB)",
    "price": 4500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Sugar (1kg)",
    "price": 1200,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Event decoration (large hall)",
    "price": 350000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Tyre change (per tyre)",
    "price": 2500,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Salt (500g)",
    "price": 350,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Milk powder (400g tin)",
    "price": 2900,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Alteration service",
    "price": 3500,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Swimming pool session",
    "price": 4000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Website design service",
    "price": 150000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Earphones (wired)",
    "price": 2500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Tailoring (native attire)",
    "price": 15000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Photography (full event)",
    "price": 150000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Notebook (A5, 100 pages)",
    "price": 800,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Yoga class",
    "price": 5000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Firewood (bundle)",
    "price": 2000,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "AA batteries (pack of 4)",
    "price": 900,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Sound system rental (per day)",
    "price": 45000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Sunglasses",
    "price": 4500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Car engine diagnostics",
    "price": 12000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Wristwatch",
    "price": 12500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Manicure",
    "price": 4500,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Bottled water (case of 50)",
    "price": 5000,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Deep home cleaning (3-bedroom)",
    "price": 45000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Backpack",
    "price": 15000,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Generator servicing",
    "price": 18000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Ankara fabric (per yard)",
    "price": 4500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Vegetable oil (5L)",
    "price": 12500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Dry cleaning (suit)",
    "price": 6500,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Fumigation service",
    "price": 25000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Detergent powder (1kg)",
    "price": 1800,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Printer paper (ream)",
    "price": 3800,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Business consulting (per hour)",
    "price": 20000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Insecticide spray",
    "price": 2400,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Graphic design service",
    "price": 20000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Photography session (1 hour)",
    "price": 25000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Sprite (crate of 24)",
    "price": 4800,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Paint (4L, emulsion)",
    "price": 9500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Rechargeable lantern",
    "price": 8500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Hair braiding (full head)",
    "price": 15000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "HDMI cable (2m)",
    "price": 3200,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Memory card (64GB)",
    "price": 11000,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Personal training session",
    "price": 15000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Chair and canopy rental (100 seats)",
    "price": 60000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Accounting/bookkeeping (monthly)",
    "price": 35000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Phone battery replacement",
    "price": 8000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Bar soap (pack of 6)",
    "price": 1500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Men's cap",
    "price": 2500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Bottled water (case of 24)",
    "price": 3500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Pedicure",
    "price": 5500,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Ironing service (per item)",
    "price": 500,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Cement (1 bag)",
    "price": 8500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Handbag",
    "price": 18500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Eggs (crate of 30)",
    "price": 3200,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Tea bags (box of 100)",
    "price": 2200,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Memory card (32GB)",
    "price": 6500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Matches (pack of 10 boxes)",
    "price": 500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Men's belt (leather)",
    "price": 6000,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Rice (50kg bag)",
    "price": 65000,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Home cleaning service (per room)",
    "price": 8000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Men's t-shirt",
    "price": 5500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Umbrella",
    "price": 3500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "USB cable (1m)",
    "price": 1500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Data recovery service",
    "price": 20000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Courier/delivery (within city)",
    "price": 2000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Legal consultation (per hour)",
    "price": 15000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Women's hair styling",
    "price": 8500,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Phone charger (Type-C)",
    "price": 3500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Social media management (monthly)",
    "price": 60000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Coca-Cola (crate of 24)",
    "price": 4800,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Car wash (full detailing)",
    "price": 15000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Phone screen repair",
    "price": 15000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Phone screen protector",
    "price": 1500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Full body massage",
    "price": 25000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Candles (pack of 12)",
    "price": 1600,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Laundry service (per load)",
    "price": 3500,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Ballpoint pens (pack of 10)",
    "price": 1200,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Men's haircut",
    "price": 2500,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Phone charger (Lightning)",
    "price": 4200,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Phone case",
    "price": 3000,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Coffee (250g)",
    "price": 3800,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Laptop repair (motherboard)",
    "price": 45000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Spaghetti (carton)",
    "price": 8500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Malt drink (crate of 24)",
    "price": 6500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Bridal makeup package",
    "price": 45000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Bread (loaf)",
    "price": 1200,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Passport photo session",
    "price": 1500,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Women's blouse",
    "price": 7500,
    "type": "sale",
    "currency": "NGN"
  },
  {
    "name": "Electrical wiring repair",
    "price": 15000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Car wash (exterior)",
    "price": 3000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Facial treatment",
    "price": 12000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Tailoring (suit)",
    "price": 35000,
    "type": "service",
    "currency": "NGN"
  },
  {
    "name": "Plumbing repair (per visit)",
    "price": 12000,
    "type": "service",
    "currency": "NGN"
  }
];

async function seed() {
  let created = 0;
  let failed = 0;

  for (const item of ITEMS) {
    try {
      const res = await fetch(`${BASE_URL}/api/catalog`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });
      const body = await res.json();
      if (!res.ok) {
        console.error(`FAILED: ${item.name} - ${body.message || (body.errors && body.errors.join(', '))}`);
        failed += 1;
        continue;
      }
      created += 1;
      if (created % 10 === 0) console.log(`...${created} items created`);
    } catch (err) {
      console.error(`FAILED: ${item.name} - ${err.message}`);
      failed += 1;
    }
  }

  console.log(`\nDone. Created ${created}/${ITEMS.length} items${failed ? `, ${failed} failed` : ''}.`);
  if (failed > 0) process.exitCode = 1;
}

seed();
