/**
 * generate-nodes-json.js
 * Emits the JSON node-tree deliverable from the live nodeset definition.
 * Run via: npm run gen:nodes
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { SimulationEngine } from '../src/simulation/engine.js';
import { DEFAULT_CONFIG }    from '../src/simulation/config.js';
import { buildNodeset, toJSON } from '../src/opcua/nodeset.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath   = join(__dirname, '..', 'docs', 'opcua', 'nodes.json');

const engine = new SimulationEngine(DEFAULT_CONFIG);
const tree   = buildNodeset(engine);
const json   = toJSON(tree);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(json, null, 2) + '\n', 'utf8');

console.log(`wrote ${outPath}`);
