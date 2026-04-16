# Installation

> Learn how to install and configure Nuxt UI in your Nuxt application.

> [!NOTE]
> See: /docs/getting-started/installation/vue
> Looking for the Vue version?

## Setup

### Add to a Nuxt project

Install the Nuxt UI package
```bash
pnpm add @nuxt/ui tailwindcss

```

```bash
yarn add @nuxt/ui tailwindcss

```

```bash
npm install @nuxt/ui tailwindcss

```

```bash
bun add @nuxt/ui tailwindcss

```
Add the Nuxt UI module in your nuxt.config.ts
```ts
export default defineNuxtConfig({
  modules: ['@nuxt/ui']
})

```
> [!NOTE]
> There is no need to add `@nuxt/icon`, `@nuxt/fonts` or `@nuxtjs/color-mode` to your `modules` array as Nuxt UI registers them automatically. You can still configure these modules in your `nuxt.config.ts` using the `icon`, `fonts` and `colorMode` keys.

Import Tailwind CSS and Nuxt UI in your CSS
```css
@import "tailwindcss";
@import "@nuxt/ui";

```

```ts
export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css']
})

```
> [!TIP]
> See: https://nuxt.com/docs/getting-started/layers
> When using [Nuxt Layers](https://nuxt.com/docs/getting-started/layers), the module automatically generates [`@source`](https://tailwindcss.com/docs/functions-and-directives#source-directive) directives for each layer directory, ensuring Tailwind CSS scans all your layer source files for utility classes.

> [!NOTE]
> It's recommended to install the [Tailwind CSS IntelliSense](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss) extension for VSCode and add the following settings:
> ```json
> {
>   "files.associations": {
>     "*.css": "tailwindcss"
>   },
>   "editor.quickSuggestions": {
>     "strings": "on"
>   },
>   "tailwindCSS.classAttributes": ["class", "ui"],
>   "tailwindCSS.classFunctions": ["defineAppConfig"]
> }
> 
> ```

Wrap your app with App component
```vue
<template>
  <UApp>
    <NuxtPage />
  </UApp>
</template>

```
> [!NOTE]
> See: /docs/components/app
> The `App` component provides global configurations and is required for Toast, Tooltip components to work as well as Programmatic Overlays.

### Use a Nuxt template

Get started with one of our [official templates](/templates) by using the `Use this template` button on GitHub or the CLI:

```bash
npm create nuxt@latest -- -t ui

```

```bash
npm create nuxt@latest -- -t ui/landing

```

```bash
npm create nuxt@latest -- -t ui/docs

```

```bash
npm create nuxt@latest -- -t ui/saas

```

```bash
npm create nuxt@latest -- -t ui/dashboard

```

```bash
npm create nuxt@latest -- -t ui/chat

```

```bash
npm create nuxt@latest -- -t ui/portfolio

```

```bash
npm create nuxt@latest -- -t ui/changelog

```

```bash
npm create nuxt@latest -- -t ui/editor

```

**Starter**
A minimal template to get started with Nuxt UI.

**Landing**
A modern landing page template powered by Nuxt Content.

**Docs**
A documentation template powered by Nuxt Content.

**SaaS**
A SaaS template with landing, pricing, docs and blog powered by Nuxt Content.

**Dashboard**
A dashboard template with multi-column layout for building sophisticated admin interfaces.

**Chat**
An AI chatbot template to build your own chatbot powered by Vercel AI SDK.

**Portfolio**
A sleek portfolio template to showcase your work, skills and blog powered by Nuxt Content.

**Changelog**
A changelog template to display your repository releases notes from GitHub powered by Nuxt MDC.

**Editor**
A rich text editor template powered by TipTap with support for markdown, HTML, and JSON content types.

## Options

You can customize Nuxt UI by providing options in your `nuxt.config.ts`.

### `prefix`

Use the `prefix` option to change the prefix of the components.

- Default: `U`

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  ui: {
    prefix: 'Nuxt'
  }
})
```

### `fonts`

Use the `fonts` option to enable or disable the [`@nuxt/fonts`](https://github.com/nuxt/fonts) module.

- Default: `true`

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  ui: {
    fonts: false
  }
})
```

### `colorMode`

Use the `colorMode` option to enable or disable the [`@nuxt/color-mode`](https://github.com/nuxt-modules/color-mode) module.

- Default: `true`

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  ui: {
    colorMode: false
  }
})
```

### `theme.colors`

Use the `theme.colors` option to define the dynamic color aliases used to generate components theme.

- Default: `['primary', 'secondary', 'success', 'info', 'warning', 'error']`

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  ui: {
    theme: {
      colors: ['primary', 'error']
    }
  }
})
```

> [!TIP]
> See: /docs/getting-started/theme/design-system#colors
> Learn more about color customization and theming in the Theme section.

### `theme.transitions`

Use the `theme.transitions` option to enable or disable transitions on components.

- Default: `true`

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  ui: {
    theme: {
      transitions: false
    }
  }
})
```

> [!NOTE]
> This option adds the `transition-colors` class on components with hover or active states.

### `theme.defaultVariants`

Use the `theme.defaultVariants` option to override the default `color` and `size` variants for components.

- Default: `{ color: 'primary', size: 'md' }`

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  ui: {
    theme: {
      defaultVariants: {
        color: 'neutral',
        size: 'sm'
      }
    }
  }
})
```

### `theme.prefix` `4.2+`

Use the `theme.prefix` option to configure the same prefix you set on your Tailwind CSS import. This ensures Nuxt UI components use the correct prefixed utility classes and CSS variables.

```ts
export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  ui: {
    theme: {
      prefix: 'tw'
    }
  }
})

```

```css
@import "tailwindcss" prefix(tw);
@import "@nuxt/ui";

```

> [!WARNING]
> See: https://fonts.nuxt.com/get-started/configuration#processcssvariables
> You might need to enable `fonts.processCSSVariables` to use the prefix option with the `@nuxt/fonts` module:
> ```ts
> export default defineNuxtConfig({
>   modules: ['@nuxt/ui'],
>   css: ['~/assets/css/main.css'],
>   ui: {
>     theme: {
>       prefix: 'tw'
>     }
>   },
>   fonts: {
>     processCSSVariables: true
>   }
> })
> 
> ```

This will automatically prefix all Tailwind utility classes and CSS variables in Nuxt UI component themes:

```html
<!-- Without prefix -->
<button class="px-2 py-1 text-xs hover:bg-primary/75">Button</button>

<!-- With prefix: tw -->
<button class="tw:px-2 tw:py-1 tw:text-xs tw:hover:bg-primary/75">Button</button>
```

> [!NOTE]
> See: https://tailwindcss.com/docs/styling-with-utility-classes#using-the-prefix-option
> Learn more about using a prefix in the Tailwind CSS documentation.

### `prose`

Use the `prose` option to force the import of Nuxt UI `<Prose>` components even if `@nuxtjs/mdc` or `@nuxt/content` is not installed.

- Default: `false`

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  ui: {
    prose: true
  }
})
```

### `mdc` `Deprecated`

Use the [`prose`](#prose) option instead.

### `content`

Use the `content` option to force the import of Nuxt UI `<Prose>` and `<UContent>` components even if `@nuxt/content` is not installed.

- Default: `false`

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  ui: {
    content: true
  }
})
```

### `experimental.componentDetection` `4.1+`

Use the `experimental.componentDetection` option to enable automatic component detection for tree-shaking. This feature scans your source code to detect which components are actually used and only generates the necessary CSS for those components (including their dependencies).

- Default: `false`
- Type: `boolean | string[]`

**Enable automatic detection:**

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  ui: {
    experimental: {
      componentDetection: true
    }
  }
})
```

**Include additional components for dynamic usage:**

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  ui: {
    experimental: {
      componentDetection: ['Modal', 'Dropdown', 'Popover']
    }
  }
})
```

> [!NOTE]
> When providing an array of component names, automatic detection is enabled and these components (along with their dependencies) are guaranteed to be included. This is useful for dynamic components like `<component :is="..." />` that can't be statically analyzed.

## Continuous releases

Nuxt UI uses [pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new) for continuous preview releases, providing developers with instant access to the latest features and bug fixes without waiting for official releases.

Automatic preview releases are created for all commits and PRs to the `v4` branch. Use them by replacing your package version with the specific commit hash or PR number.

```diff [package.json]
{
  "dependencies": {
-   "@nuxt/ui": "^4.0.0",
+   "@nuxt/ui": "https://pkg.pr.new/@nuxt/ui@4c96909",
  }
}
```

> [!NOTE]
> pkg.pr.new will automatically comment on PRs with the installation URL, making it easy to test changes.

