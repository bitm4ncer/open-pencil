import { ref } from 'vue'

/** A prompt waiting for the chat composer to mount or the chat panel to open. */
export const pendingChatPrompt = ref<string | null>(null)

export function queueChatPrompt(text: string): void {
  pendingChatPrompt.value = text
}

export function takeChatPrompt(): string | null {
  const text = pendingChatPrompt.value
  pendingChatPrompt.value = null
  return text
}
