// Metro config for the monorepo.
//
// Two things Metro needs help with here:
//   1. Watch the workspace root so `health-sync` (packages/engine) resolves
//      from source, and look for modules in both node_modules trees.
//   2. The engine is written for Node ESM, where relative imports carry a
//      ".js" extension even though the source files are ".ts". Metro has no
//      such convention, so map a failed "./x.js" resolution onto "./x.ts".

const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");
const fs = require("node:fs");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Rewrite relative "./foo.js" -> "./foo.ts"/"./foo.tsx" when only the
  // TypeScript source exists (Node ESM style imports inside the engine).
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    const basePath = path.resolve(
      path.dirname(context.originModulePath),
      moduleName.slice(0, -3),
    );
    for (const ext of [".ts", ".tsx"]) {
      if (fs.existsSync(basePath + ext)) {
        return context.resolveRequest(context, moduleName.slice(0, -3) + ext, platform);
      }
    }
  }
  return (defaultResolveRequest ?? context.resolveRequest)(
    context,
    moduleName,
    platform,
  );
};

module.exports = config;
