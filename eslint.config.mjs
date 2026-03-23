import { defineConfig, globalIgnores } from "eslint/config";
import nextConfig from 'eslint-config-next/core-web-vitals.js';
import nextTs from "eslint-config-next/typescript.js";

const eslintConfig = defineConfig([
  ...nextConfig,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;