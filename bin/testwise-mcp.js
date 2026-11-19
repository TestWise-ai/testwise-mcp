#!/usr/bin/env node
import { exitWithError } from '../src/log.js';
import { main } from '../src/main.js';

main().catch((error) => exitWithError(`stopped: ${error?.message ?? error}`));
