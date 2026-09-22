#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshGeneratedModelDataManifest } from "./model-data.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

refreshGeneratedModelDataManifest(packageRoot);
