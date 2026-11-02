#!/usr/bin/env node
// @ts-check
import { exitWhenDone } from '../src/auth.js';
import { main } from '../src/cli.js';

exitWhenDone(await main(process.argv.slice(2)));
