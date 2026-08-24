import { renderToString } from '@vue/server-renderer'
import { createSSRApp, type VNode } from 'vue'

export function renderToMarkup(node: VNode): Promise<string> {
  return renderToString(createSSRApp({ render: () => node }))
}
