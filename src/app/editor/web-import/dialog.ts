import { ref } from 'vue'

/** The File → Import from Web… dialog, shared by the menu and the command palette. */
export const webImportOpen = ref(false)

export function openWebImportDialog(): void {
  webImportOpen.value = true
}
