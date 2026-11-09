import { showChatPanel } from '@/app/ai/chat/panel'
import { queueChatPrompt } from '@/app/ai/chat/prompt'
import type { EditorStore } from '@/app/editor/session'

/**
 * Hands a fresh web import to the chat agent: the reference layer is the visual target, and the
 * agent can repair assets, structure, naming, and the page itself with the editor tools.
 */
export function refineWebImport(store: EditorStore, url: string): void {
  store.state.showUI = true
  showChatPanel()
  queueChatPrompt(
    `Refine the web import from ${url}.\n\n` +
      `Compare the imported page with the reference layer beside it, when one was placed, and improve the current document:\n` +
      '- restore missing images, icons, background media, navigation, and hero media;\n' +
      '- fix text wrapping, font fallbacks, and colors where they differ from the reference;\n' +
      '- organize the layers into a clear hierarchy and give them semantic names;\n' +
      '- keep editing this document with the OpenPencil editor tools; do not re-import unless it is necessary.'
  )
}
