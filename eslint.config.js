// @ts-check
const eslint = require("@eslint/js");
const { defineConfig } = require("eslint/config");
const tseslint = require("typescript-eslint");
const angular = require("angular-eslint");

module.exports = defineConfig([
  {
    files: ["**/*.ts"],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-debugger": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@angular-eslint/directive-selector": [
        "error",
        {
          type: "attribute",
          prefix: "app",
          style: "camelCase",
        },
      ],
      "@angular-eslint/component-selector": [
        "error",
        {
          type: "element",
          prefix: "app",
          style: "kebab-case",
        },
      ],
    },
  },
  {
    // These renderer surfaces still carry operator-facing diagnostics or
    // approval/performance traces. Keep the exception narrow while banning
    // stray console.log/info calls everywhere else.
    files: [
      "src/renderer/app/core/services/ipc/instance-ipc.service.ts",
      "src/renderer/app/core/services/perf-instrumentation.service.ts",
      "src/renderer/app/core/state/instance/instance-list.store.ts",
      "src/renderer/app/core/state/verification/verification.store.ts",
      "src/renderer/app/features/dashboard/dashboard.component.ts",
      "src/renderer/app/features/instance-detail/file-attachment.service.ts",
      "src/renderer/app/features/instance-detail/input-panel.component.ts",
      "src/renderer/app/features/instance-detail/instance-detail.component.ts",
      "src/renderer/app/features/instance-detail/user-action-request.component.ts",
      "src/renderer/app/features/verification/config/cli-settings-panel.component.ts",
      "src/renderer/app/shared/components/message-attachments/message-attachments.component.ts",
    ],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["**/*.html"],
    extends: [
      angular.configs.templateRecommended,
      angular.configs.templateAccessibility,
    ],
    rules: {},
  }
]);
