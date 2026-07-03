// `@babylonjs/lite` (>=1.6.0) reads the WebGPU bitmask globals
// (`GPUShaderStage`, `GPUTextureUsage`, `GPUBufferUsage`, `GPUColorWrite`) at
// module-evaluation time. Node has no WebGPU implementation, so importing the
// engine throws before any test runs. The connector only touches metadata in
// these suites, so stub the globals with bit flags — values are unused, only
// the bitwise ORs need to not explode.
const flags = (keys: string[]): Record<string, number> =>
  Object.fromEntries(keys.map((key, index) => [key, 1 << index]));

const g = globalThis as Record<string, unknown>;
g.GPUShaderStage ??= flags(["VERTEX", "FRAGMENT", "COMPUTE"]);
g.GPUTextureUsage ??= flags([
  "COPY_SRC",
  "COPY_DST",
  "TEXTURE_BINDING",
  "STORAGE_BINDING",
  "RENDER_ATTACHMENT",
]);
g.GPUBufferUsage ??= flags([
  "MAP_READ",
  "MAP_WRITE",
  "COPY_SRC",
  "COPY_DST",
  "INDEX",
  "VERTEX",
  "UNIFORM",
  "STORAGE",
  "INDIRECT",
  "QUERY_RESOLVE",
]);
g.GPUColorWrite ??= flags(["RED", "GREEN", "BLUE", "ALPHA", "ALL"]);
