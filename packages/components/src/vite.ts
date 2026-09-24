import type { Plugin } from 'vite'

/** A Numen Entry runs inside the host Vue tree: never bundle a second Vue runtime. */
export function numenPluginRuntime(): Plugin {
  const shared: Record<string, string> = {
    vue: '/workbench/vue.js',
    cordis: '/workbench/cordis.js',
    '@numenjs/components': '/workbench/components.js',
  }
  const hostStyle = '\0numen-host-component-style'
  return {
    name: 'numen-plugin-runtime',
    enforce: 'pre',
    resolveId(source) {
      if (source === '@numenjs/components/style.css') return hostStyle
      if (shared[source]) return { id: shared[source], external: true }
      if (source.startsWith('@vue/') || source.startsWith('vue/')) {
        this.error(`Import Vue from "vue" in Numen Entries; private runtime subpath "${source}" cannot be shared.`)
      }
    },
    load(id) { if (id === hostStyle) return 'export {}' },
  }
}
