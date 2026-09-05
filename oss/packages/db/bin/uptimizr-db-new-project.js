#!/usr/bin/env node
// Thin launcher so the bin exists at install time (pnpm links workspace bins before
// `dist/` is built and warned "Failed to create bin" for every dependant otherwise).
import "../dist/cli/createProject.js";
