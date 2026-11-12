<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue"
import { ZoomIn, ZoomOut, RotateCw, X } from "@lucide/vue"
import { Separator } from "@/components/ui/separator"

const props = defineProps<{
  image: { src: string; alt: string } | null
}>()

const emit = defineEmits<{
  (e: "close"): void
}>()

const scale = ref(1)
const rotate = ref(0)
const translateX = ref(0)
const translateY = ref(0)

const isDragging = ref(false)
let startX = 0
let startY = 0
let initialTranslateX = 0
let initialTranslateY = 0

function reset() {
  scale.value = 1
  rotate.value = 0
  translateX.value = 0
  translateY.value = 0
}

watch(
  () => props.image,
  () => {
    reset()
  },
)

function zoomIn() {
  scale.value = Math.min(5, Number((scale.value + 0.25).toFixed(2)))
}

function zoomOut() {
  scale.value = Math.max(0.25, Number((scale.value - 0.25).toFixed(2)))
  if (scale.value <= 1) {
    translateX.value = 0
    translateY.value = 0
  }
}

function rotateImage() {
  rotate.value = (rotate.value + 90) % 360
}

function handleWheel(event: WheelEvent) {
  event.preventDefault()
  const delta = event.deltaY < 0 ? 0.15 : -0.15
  const newScale = Math.min(5, Math.max(0.25, Number((scale.value + delta).toFixed(2))))
  scale.value = newScale
  if (newScale <= 1) {
    translateX.value = 0
    translateY.value = 0
  }
}

function startDrag(event: MouseEvent) {
  if (scale.value <= 1 && rotate.value === 0) return
  isDragging.value = true
  startX = event.clientX
  startY = event.clientY
  initialTranslateX = translateX.value
  initialTranslateY = translateY.value

  window.addEventListener("mousemove", onDrag)
  window.addEventListener("mouseup", stopDrag)
}

function onDrag(event: MouseEvent) {
  if (!isDragging.value) return
  const dx = event.clientX - startX
  const dy = event.clientY - startY
  translateX.value = initialTranslateX + dx
  translateY.value = initialTranslateY + dy
}

function stopDrag() {
  isDragging.value = false
  window.removeEventListener("mousemove", onDrag)
  window.removeEventListener("mouseup", stopDrag)
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === "Escape" && props.image) {
    emit("close")
  }
}

onMounted(() => {
  window.addEventListener("keydown", handleKeyDown)
})

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeyDown)
  stopDrag()
})
</script>

<template>
  <div
    v-if="image"
    class="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex flex-col select-none animate-in fade-in duration-200"
    @click="emit('close')"
  >
    <!-- 控制栏 -->
    <div
      class="h-12 flex items-center justify-between px-4 text-white/90 shrink-0 border-b border-white/10"
      @click.stop
    >
      <div class="text-xs truncate max-w-md font-mono text-white/70">
        {{ image.alt || "图片预览" }} ({{ Math.round(scale * 100) }}%)
      </div>

      <div class="flex items-center gap-1.5">
        <button
          class="p-1.5 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition cursor-pointer"
          @click="zoomIn"
          title="放大 (滚轮向上 / +)"
        >
          <ZoomIn class="size-4" />
        </button>
        <button
          class="p-1.5 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition cursor-pointer"
          @click="zoomOut"
          title="缩小 (滚轮向下 / -)"
        >
          <ZoomOut class="size-4" />
        </button>
        <button
          class="p-1.5 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition cursor-pointer"
          @click="rotateImage"
          title="顺时针旋转 90°"
        >
          <RotateCw class="size-4" />
        </button>
        <button
          class="p-1.5 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition cursor-pointer"
          @click="reset"
          title="重置比例 (双击图片也可复原)"
        >
          <span class="text-xs font-mono">1:1</span>
        </button>
        <Separator orientation="vertical" class="h-4 bg-white/20 mx-1" />
        <button
          class="p-1.5 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition cursor-pointer"
          @click="emit('close')"
          title="关闭 (Esc)"
        >
          <X class="size-4" />
        </button>
      </div>
    </div>

    <!-- 展示主体，支持滚轮缩放与鼠标拖拽平移 -->
    <div
      class="flex-1 flex items-center justify-center p-6 overflow-hidden cursor-grab active:cursor-grabbing"
      @wheel.prevent="handleWheel"
      @mousedown="startDrag"
      @dblclick="reset"
    >
      <img
        :src="image.src"
        :alt="image.alt"
        class="max-w-full max-h-full object-contain shadow-2xl rounded-lg pointer-events-none transition-transform duration-75 ease-out"
        :style="{
          transform: `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale}) rotate(${rotate}deg)`,
        }"
      />
    </div>
  </div>
</template>
