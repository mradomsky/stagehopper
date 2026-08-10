<script lang="ts">
	import { clampPan, clampScale, fitScale, type ViewportTransform } from '../map-viewer.js';

	interface Props {
		mapUrl: string;
		onClose: () => void;
	}

	const { mapUrl, onClose }: Props = $props();

	const MAX_ZOOM_FACTOR = 4;

	// ---- State ----
	let containerWidth = $state(0);
	let containerHeight = $state(0);
	let imgWidth = $state(0);
	let imgHeight = $state(0);
	let transform = $state<ViewportTransform>({ scale: 1, x: 0, y: 0 });
	let loadError = $state(false);
	let lastTapTime = 0;
	let lastTapX = 0;
	let lastTapY = 0;

	// ---- Derived ----
	const minScale = $derived(fitScale(imgWidth, imgHeight, containerWidth, containerHeight));
	const maxScale = $derived(Math.max(minScale, MAX_ZOOM_FACTOR));
	const transformStyle = $derived(
		`translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`
	);

	/** Initialize transform once image loads and viewport is known. */
	function handleImageLoad(event: Event) {
		const img = event.target as HTMLImageElement;
		imgWidth = img.naturalWidth;
		imgHeight = img.naturalHeight;

		if (containerWidth > 0 && containerHeight > 0 && imgWidth > 0 && imgHeight > 0) {
			const fit = fitScale(imgWidth, imgHeight, containerWidth, containerHeight);
			transform = clampPan({ scale: fit, x: 0, y: 0 }, imgWidth, imgHeight, containerWidth, containerHeight);
		}
	}

	function handleImageError() {
		loadError = true;
	}

	/** Handle single/two-pointer touches: 1-pointer drag = pan, 2-pointer pinch = zoom. */
	function handlePointerDown(e: PointerEvent) {
		if (e.buttons === 0 && e.pointerType === 'touch') {
			const now = Date.now();
			const dx = Math.abs(e.clientX - lastTapX);
			const dy = Math.abs(e.clientY - lastTapY);
			const isDoubleTap = now - lastTapTime < 300 && dx < 50 && dy < 50;

			if (isDoubleTap) {
				const targetScale = transform.scale > minScale * 1.5 ? minScale : minScale * 2;
				const newScale = clampScale(targetScale, minScale, maxScale);
				const pivot = {
					x: e.clientX - containerWidth / 2,
					y: e.clientY - containerHeight / 2
				};
				const newX = pivot.x - (pivot.x - transform.x) * (newScale / transform.scale);
				const newY = pivot.y - (pivot.y - transform.y) * (newScale / transform.scale);
				transform = clampPan({ scale: newScale, x: newX, y: newY }, imgWidth, imgHeight, containerWidth, containerHeight);
			}

			lastTapTime = now;
			lastTapX = e.clientX;
			lastTapY = e.clientY;
		}
	}

	/** Pan with 1-pointer drag. */
	function handlePointerMove(e: PointerEvent) {
		if (e.isPrimary && (e.buttons & 1)) {
			transform = clampPan(
				{ ...transform, x: transform.x + e.movementX, y: transform.y + e.movementY },
				imgWidth,
				imgHeight,
				containerWidth,
				containerHeight
			);
		}
	}

	/** Zoom via wheel. */
	function handleWheel(e: WheelEvent) {
		e.preventDefault();
		const zoomIn = e.deltaY < 0;
		const zoomFactor = zoomIn ? 1.15 : 0.85;
		const newScale = clampScale(transform.scale * zoomFactor, minScale, maxScale);
		if (newScale === transform.scale) return;

		const pivot = {
			x: e.clientX - containerWidth / 2,
			y: e.clientY - containerHeight / 2
		};
		const newX = pivot.x - (pivot.x - transform.x) * (newScale / transform.scale);
		const newY = pivot.y - (pivot.y - transform.y) * (newScale / transform.scale);
		transform = clampPan({ scale: newScale, x: newX, y: newY }, imgWidth, imgHeight, containerWidth, containerHeight);
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
		style="touch-action: none; overflow: hidden;"
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onwheel={handleWheel}
	>
		{#if loadError}
			<div class="map-error">Couldn't load the map.</div>
		{:else}
			<img
				class="map-image"
				src={mapUrl}
				alt="Festival map"
				style="transform: {transformStyle}"
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
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.map-container {
		position: relative;
		width: 100%;
		height: 100%;
	}

	.map-image {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		object-fit: contain;
		transform-origin: 0 0;
		user-select: none;
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
