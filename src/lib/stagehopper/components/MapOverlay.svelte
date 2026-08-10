<script lang="ts">
	import { clampPan, clampScale, fitScale, type ViewportTransform } from '../map-viewer.js';

	interface Props {
		mapUrl: string;
		onClose: () => void;
	}

	const { mapUrl, onClose }: Props = $props();

	/** Ceiling for zoom, as a multiple of the contain-fit scale. */
	const MAX_ZOOM_FACTOR = 4;
	/** A double-tap must land within this window (ms) and travel less than {@link TAP_SLOP}px. */
	const DOUBLE_TAP_MS = 300;
	const TAP_SLOP = 40;

	let containerWidth = $state(0);
	let containerHeight = $state(0);
	let imgWidth = $state(0);
	let imgHeight = $state(0);
	/** `x`/`y` translate the natural-size image; `scale` maps natural px → screen px. */
	let transform = $state<ViewportTransform>({ scale: 1, x: 0, y: 0 });
	let loadError = $state(false);
	let initialized = false;

	/** Live pointers by id — plain Map, not reactive; drives pan (1) and pinch (2). */
	const pointers = new Map<number, { x: number; y: number }>();
	/** Two-finger distance at the last pinch sample, to derive the scale ratio. */
	let pinchPrevDist = 0;

	let lastTapTime = 0;
	let lastTapX = 0;
	let lastTapY = 0;

	const minScale = $derived(fitScale(imgWidth, imgHeight, containerWidth, containerHeight));
	const maxScale = $derived(Math.max(minScale, minScale * MAX_ZOOM_FACTOR));
	const transformStyle = $derived(
		`translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`
	);

	/**
	 * Fit the map to the viewport once both the image size and the container size are
	 * known — as an effect, since either can settle first (a cached image fires `load`
	 * before layout; a cold one after).
	 */
	$effect(() => {
		if (initialized) return;
		if (imgWidth > 0 && imgHeight > 0 && containerWidth > 0 && containerHeight > 0) {
			const fit = fitScale(imgWidth, imgHeight, containerWidth, containerHeight);
			transform = clampPan(
				{ scale: fit, x: 0, y: 0 },
				imgWidth,
				imgHeight,
				containerWidth,
				containerHeight
			);
			initialized = true;
		}
	});

	function handleImageLoad(event: Event) {
		const img = event.target as HTMLImageElement;
		imgWidth = img.naturalWidth;
		imgHeight = img.naturalHeight;
	}

	function handleImageError() {
		loadError = true;
	}

	/**
	 * Re-scale around a screen point (relative to the container's top-left, which the
	 * full-screen overlay pins to the viewport origin), keeping that point fixed under
	 * the cursor/fingers.
	 */
	function zoomTo(newScaleRaw: number, focusX: number, focusY: number) {
		const newScale = clampScale(newScaleRaw, minScale, maxScale);
		if (newScale === transform.scale) return;
		const ratio = newScale / transform.scale;
		const x = focusX - ratio * (focusX - transform.x);
		const y = focusY - ratio * (focusY - transform.y);
		transform = clampPan({ scale: newScale, x, y }, imgWidth, imgHeight, containerWidth, containerHeight);
	}

	function pinchDistance(): number {
		const [a, b] = [...pointers.values()];
		if (!a || !b) return 0;
		return Math.hypot(a.x - b.x, a.y - b.y);
	}

	function pinchMidpoint(): { x: number; y: number } {
		const [a, b] = [...pointers.values()];
		if (!a || !b) return { x: 0, y: 0 };
		return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	}

	function handlePointerDown(e: PointerEvent) {
		(e.currentTarget as Element).setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

		if (pointers.size === 2) {
			pinchPrevDist = pinchDistance();
			return;
		}

		// Single pointer: detect a double-tap and toggle between fit and 2× around it.
		const now = Date.now();
		const isDoubleTap =
			now - lastTapTime < DOUBLE_TAP_MS &&
			Math.abs(e.clientX - lastTapX) < TAP_SLOP &&
			Math.abs(e.clientY - lastTapY) < TAP_SLOP;
		if (isDoubleTap) {
			const target = transform.scale > minScale * 1.5 ? minScale : minScale * 2;
			zoomTo(target, e.clientX, e.clientY);
			lastTapTime = 0;
			return;
		}
		lastTapTime = now;
		lastTapX = e.clientX;
		lastTapY = e.clientY;
	}

	function handlePointerMove(e: PointerEvent) {
		const prev = pointers.get(e.pointerId);
		if (!prev) return;

		if (pointers.size >= 2) {
			// Pinch: update this finger, then scale by how the two-finger span changed.
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			const dist = pinchDistance();
			if (pinchPrevDist > 0) {
				const mid = pinchMidpoint();
				zoomTo(transform.scale * (dist / pinchPrevDist), mid.x, mid.y);
			}
			pinchPrevDist = dist;
			return;
		}

		// Pan.
		const dx = e.clientX - prev.x;
		const dy = e.clientY - prev.y;
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		transform = clampPan(
			{ ...transform, x: transform.x + dx, y: transform.y + dy },
			imgWidth,
			imgHeight,
			containerWidth,
			containerHeight
		);
	}

	function handlePointerUp(e: PointerEvent) {
		pointers.delete(e.pointerId);
		pinchPrevDist = 0;
	}

	function handleWheel(e: WheelEvent) {
		e.preventDefault();
		const factor = e.deltaY < 0 ? 1.15 : 0.85;
		zoomTo(transform.scale * factor, e.clientX, e.clientY);
	}

	function handleKeyDown(event: KeyboardEvent) {
		if (event.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={handleKeyDown} />

<div class="map-overlay" role="presentation">
	<div
		class="map-container"
		role="presentation"
		bind:clientWidth={containerWidth}
		bind:clientHeight={containerHeight}
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
		onpointercancel={handlePointerUp}
		onwheel={handleWheel}
	>
		{#if loadError}
			<div class="map-error">Couldn't load the map.</div>
		{:else}
			<img
				class="map-image"
				src={mapUrl}
				alt="Festival map"
				draggable="false"
				style="width: {imgWidth}px; height: {imgHeight}px; transform: {transformStyle}"
				onload={handleImageLoad}
				onerror={handleImageError}
			/>
		{/if}
	</div>

	<button class="map-close" onclick={onClose} aria-label="Close">✕</button>
</div>

<style>
	.map-overlay {
		position: fixed;
		inset: 0;
		background: #111;
		z-index: 70;
	}

	.map-container {
		position: absolute;
		inset: 0;
		overflow: hidden;
		touch-action: none;
	}

	.map-image {
		position: absolute;
		top: 0;
		left: 0;
		transform-origin: 0 0;
		user-select: none;
		pointer-events: none;
		will-change: transform;
	}

	.map-error {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		color: #ccc;
		font-size: 0.9rem;
		text-align: center;
	}

	.map-close {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		border: none;
		background: rgba(0, 0, 0, 0.5);
		color: #fffaf0;
		font-size: 0.9rem;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		z-index: 2;
	}

	@media (hover: hover) and (pointer: fine) {
		.map-close:hover {
			background: rgba(0, 0, 0, 0.7);
		}
	}
</style>
