// Single source of truth for the package version. Read at runtime from the
// nearest package.json so the McpServer version, OTel tracer/meter version, and
// the outbound USER_AGENT never drift from package.json again (they used to be
// hardcoded to 3.10.0 / 3.5.0 / 3.7.0 independently).
//
// Read at runtime rather than through a compile-time JSON import: nodenext
// would need an import attribute, and tsc does not copy package.json into the
// build output. See package-root.ts for how the file is found.
import { PACKAGE } from "./package-root.js";

export const VERSION = PACKAGE.version;
