/**
 * Export the studio catalogue for the static build.
 *
 * lib/seed.js stays the single source of truth for plans, classes, teachers and
 * the weekly grid. On a real server that data is read directly; on GitHub Pages
 * there is no server, so the same records are written out as JSON for the
 * browser-side adapter to load.
 *
 *   node scripts/build-catalogue.js
 */

const fs = require('fs');
const path = require('path');
const seed = require('../lib/seed');

const out = path.join(__dirname, '..', 'public', 'assets', 'data', 'catalogue.json');
const db = seed.build();

const catalogue = {
  generatedAt: new Date().toISOString(),
  studio: db.studio,
  plans: db.plans,
  dropIn: db.dropIn,
  classTypes: db.classTypes,
  instructors: db.instructors,
  scheduleTemplate: db.scheduleTemplate,
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(catalogue, null, 2));

console.log(
  `catalogue.json written — ${catalogue.plans.length} plans, ` +
    `${catalogue.classTypes.length} class types, ${catalogue.scheduleTemplate.length} weekly slots`
);
