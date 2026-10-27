'use strict';

// Re-export shim — the design prompt has ONE source of truth:
// src/defaultDesignInstructions.js (the copy the hosted server serves).
// This root file exists only so legacy consumers (root designJobs.js →
// src/ipc/design.js, the Electron desktop layer) receive the identical
// instructions string. Do not add prompt text here; edit the src file.

module.exports = require('./src/defaultDesignInstructions.js');
