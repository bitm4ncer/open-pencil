<script setup lang="ts">
import { uniq } from 'es-toolkit/array'
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue'
import IconLaptop from '~icons/lucide/laptop'
import IconMonitor from '~icons/lucide/monitor'
import IconSmartphone from '~icons/lucide/smartphone'
import IconTablet from '~icons/lucide/tablet'
import IconTv from '~icons/lucide/tv'

import { vTestId } from '@open-pencil/vue/testing'

import type { EditorStore } from '@/app/editor/session'
import {
  DEFAULT_WEB_IMPORT_BREAKPOINT,
  WEB_IMPORT_BREAKPOINTS,
  webImportBreakpoint,
  type WebImportBreakpointId
} from '@/app/editor/web-import/breakpoints'
import { webImportOpen } from '@/app/editor/web-import/dialog'
import { discoverWebPages, importWebPage, importWebPages } from '@/app/editor/web-import/import'
import { refineWebImport } from '@/app/editor/web-import/refine'
import AppButton from '@/components/ui/button/AppButton.vue'
import {
  AppDialogBody,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogRoot
} from '@/components/ui/dialog'
import AppAlert from '@/components/ui/feedback/AppAlert.vue'
import AppInput from '@/components/ui/input/AppInput.vue'
import Tip from '@/components/ui/overlay/Tip.vue'
import AppCheckbox from '@/components/ui/toggle/AppCheckbox.vue'

const breakpointIcons = {
  '4k': IconMonitor,
  desktop: IconMonitor,
  'full-hd': IconTv,
  laptop: IconLaptop,
  tablet: IconTablet,
  mobile: IconSmartphone
}

const url = ref('')
const reference = ref(true)
const allPages = ref(false)
const responsive = ref(false)
const breakpointId = ref<WebImportBreakpointId>(DEFAULT_WEB_IMPORT_BREAKPOINT)
const breakpoint = computed(() => webImportBreakpoint(breakpointId.value))
const viewport = computed(() => ({
  width: breakpoint.value.width,
  height: breakpoint.value.height
}))
const step = ref<'url' | 'pages'>('url')
const pages = ref<string[]>([])
const selected = ref<string[]>([])
const busy = ref(false)
const discovering = ref(false)
const progress = ref('')
const error = ref<string | null>(null)
const refineOpen = ref(false)
const refineStore = shallowRef<EditorStore | null>(null)
const refineURL = ref('')
const elapsed = ref(0)
let elapsedTimer: ReturnType<typeof setInterval> | undefined

function startElapsed() {
  if (elapsedTimer) return
  elapsed.value = 0
  elapsedTimer = setInterval(() => {
    elapsed.value++
  }, 1_000)
}

function stopElapsed() {
  if (!elapsedTimer) return
  clearInterval(elapsedTimer)
  elapsedTimer = undefined
}

watch([busy, discovering], ([importing, discoveringPages]) => {
  if (importing || discoveringPages) startElapsed()
  else stopElapsed()
})
onUnmounted(stopElapsed)

const allSelected = computed(
  () => pages.value.length > 0 && selected.value.length === pages.value.length
)

watch(allPages, (enabled) => {
  if (enabled) return
  step.value = 'url'
  pages.value = []
  selected.value = []
})

function pagePath(page: string): string {
  const parsed = new URL(page)
  return `${parsed.pathname}${parsed.search}` || '/'
}

function togglePage(page: string, checked: boolean) {
  selected.value = checked
    ? uniq([...selected.value, page])
    : selected.value.filter((entry) => entry !== page)
}

function toggleAllPages() {
  selected.value = allSelected.value ? [] : [...pages.value]
}

async function discover() {
  const target = url.value.trim()
  if (!target || discovering.value) return
  discovering.value = true
  error.value = null
  try {
    pages.value = await discoverWebPages(target)
    if (pages.value.length === 0) throw new Error('No pages found in this site’s sitemap.')
    selected.value = [...pages.value]
    step.value = 'pages'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    discovering.value = false
  }
}

async function importSelected() {
  if (selected.value.length === 0 || busy.value) return
  busy.value = true
  error.value = null
  const first = selected.value[0]
  try {
    const store = await importWebPages(selected.value, {
      scroll: true,
      wait: 1_500,
      reference: reference.value,
      viewport: viewport.value,
      onProgress: (index, total, page) => {
        progress.value = `Importing ${index + 1}/${total} — ${pagePath(page)}`
      }
    })
    webImportOpen.value = false
    url.value = ''
    step.value = 'url'
    pages.value = []
    selected.value = []
    refineStore.value = store
    refineURL.value = first ?? ''
    refineOpen.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
    progress.value = ''
  }
}

async function importOne() {
  const target = url.value.trim()
  if (!target || busy.value) return
  busy.value = true
  error.value = null
  try {
    const store = await importWebPage(target, {
      scroll: true,
      wait: 1_500,
      reference: reference.value,
      viewport: viewport.value
    })
    webImportOpen.value = false
    url.value = ''
    refineStore.value = store
    refineURL.value = target
    refineOpen.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function submit() {
  if (busy.value || discovering.value) return
  if (allPages.value && step.value === 'url') {
    await discover()
    return
  }
  if (allPages.value && step.value === 'pages') {
    await importSelected()
    return
  }
  await importOne()
}

function startRefine() {
  if (refineStore.value) refineWebImport(refineStore.value, refineURL.value)
  refineOpen.value = false
}
</script>

<template>
  <AppDialogRoot v-model:open="webImportOpen" size="sm" data-test-id="web-import-dialog">
    <AppDialogHeader
      :heading="step === 'pages' ? 'Choose pages' : 'Import from Web'"
      :description="
        step === 'pages'
          ? 'Pick the pages to import. They are placed as frames in one document.'
          : 'Capture a live page into a new design tab with its styles, images, and fonts.'
      "
    />
    <form class="flex min-h-0 flex-1 flex-col" @submit.prevent="submit">
      <AppDialogBody>
        <template v-if="step === 'url'">
          <label for="web-import-url" class="mb-1.5 block text-xs font-medium text-surface">
            Page URL
          </label>
          <AppInput
            id="web-import-url"
            v-model="url"
            type="url"
            size="md"
            placeholder="https://example.com"
            autofocus
            data-test-id="web-import-url"
          />
          <p class="mt-1.5 text-xs text-muted">
            Public pages are rendered with Playwright on the local automation server.
          </p>
          <label class="mt-4 flex items-start gap-2 text-xs text-surface">
            <AppCheckbox v-model="reference" ariaLabel="Original beside import" class="mt-0.5" />
            <span>Original beside import</span>
          </label>
          <label class="mt-2 flex items-start gap-2 text-xs text-surface">
            <AppCheckbox
              v-model="allPages"
              ariaLabel="All pages"
              class="mt-0.5"
              data-test-id="web-import-all-pages"
            />
            <span>All Pages</span>
          </label>
          <p v-if="allPages" class="mt-1 text-xs text-muted">
            Reads the site’s sitemap first, then lets you choose the pages to import.
          </p>
          <div class="mt-3 rounded-md border border-border p-3">
            <label class="flex cursor-pointer items-center gap-2 text-xs text-surface">
              <AppCheckbox
                v-model="responsive"
                ariaLabel="Responsive breakpoint"
                data-test-id="web-import-responsive"
              />
              <span>Responsive</span>
              <span class="ml-auto text-muted">
                {{ breakpoint.label }} · {{ breakpoint.width }} × {{ breakpoint.height }}
              </span>
            </label>
            <div v-if="responsive" class="mt-2 grid grid-cols-6 gap-1">
              <Tip
                v-for="entry in WEB_IMPORT_BREAKPOINTS"
                :key="entry.id"
                as-child
                :label="`${entry.label} — ${entry.width} × ${entry.height}`"
              >
                <button
                  type="button"
                  v-test-id="`web-import-breakpoint-${entry.id}`"
                  class="flex h-11 cursor-pointer flex-col items-center justify-center rounded-md border px-1 text-2xs transition-colors"
                  :class="
                    breakpointId === entry.id
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-muted hover:bg-hover hover:text-surface'
                  "
                  :aria-pressed="breakpointId === entry.id"
                  @click="breakpointId = entry.id"
                >
                  <component :is="breakpointIcons[entry.id]" class="size-4" />
                  <span class="mt-0.5 leading-none">{{ entry.short }}</span>
                </button>
              </Tip>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="flex items-center justify-between text-xs text-muted">
            <span>{{ selected.length }} of {{ pages.length }} pages</span>
            <button
              type="button"
              class="cursor-pointer font-medium text-accent hover:underline"
              @click="toggleAllPages"
            >
              {{ allSelected ? 'Select none' : 'Select all' }}
            </button>
          </div>
          <div class="mt-2 max-h-64 overflow-auto rounded-md border border-border">
            <label
              v-for="page in pages"
              :key="page"
              data-test-id="web-import-page"
              class="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-xs last:border-b-0 hover:bg-hover"
            >
              <AppCheckbox
                :model-value="selected.includes(page)"
                :ariaLabel="pagePath(page)"
                @update:model-value="togglePage(page, $event)"
              />
              <Tip as-child :label="page">
                <span class="min-w-0 truncate text-surface">{{ pagePath(page) }}</span>
              </Tip>
            </label>
          </div>
          <p v-if="progress" class="mt-3 text-xs text-muted">{{ progress }}</p>
          <button
            type="button"
            class="mt-3 cursor-pointer text-xs font-medium text-muted hover:text-surface"
            @click="step = 'url'"
          >
            Back to URL
          </button>
        </template>

        <div
          v-if="busy || discovering"
          class="mt-3 flex items-center justify-between gap-3 rounded-md border border-border bg-panel px-3 py-2 text-xs text-muted"
        >
          <span class="min-w-0 truncate">
            {{ busy ? progress || 'Fetching the page…' : 'Reading the sitemap…' }}
          </span>
          <span class="shrink-0 tabular-nums">{{ elapsed }}s</span>
        </div>
        <AppAlert v-if="error" class="mt-3 whitespace-pre-line" tone="error" :heading="error" />
      </AppDialogBody>
      <AppDialogFooter>
        <AppButton class="cursor-pointer" size="md" @click="webImportOpen = false">
          Cancel
        </AppButton>
        <AppButton
          class="cursor-pointer disabled:cursor-not-allowed"
          type="submit"
          size="md"
          color="primary"
          variant="solid"
          :loading="busy || discovering"
          :disabled="step === 'pages' ? selected.length === 0 || busy : !url.trim() || discovering"
          data-test-id="web-import-submit"
        >
          {{ step === 'pages' ? 'Import selected' : 'Import' }}
        </AppButton>
      </AppDialogFooter>
    </form>
  </AppDialogRoot>

  <AppDialogRoot v-model:open="refineOpen" size="sm" data-test-id="web-import-refine">
    <AppDialogHeader
      heading="Refine with AI?"
      description="The import is ready. Let the agent compare it with the original and improve the page."
    />
    <AppDialogBody>
      <p class="text-xs leading-relaxed text-muted">
        The agent can restore missing images and icons, correct text and colors, organize and name
        the layers, and keep editing the page in OpenPencil.
      </p>
    </AppDialogBody>
    <AppDialogFooter>
      <AppButton class="cursor-pointer" size="md" @click="refineOpen = false"> Not now </AppButton>
      <AppButton
        class="cursor-pointer"
        size="md"
        color="primary"
        variant="solid"
        data-test-id="web-import-refine-start"
        @click="startRefine"
      >
        Refine with AI
      </AppButton>
    </AppDialogFooter>
  </AppDialogRoot>
</template>
