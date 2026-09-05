#!/usr/bin/env node

import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2)).then(
  (result) => {
    if (result.code !== 0) process.exitCode = result.code;
  },
  (error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  },
);
