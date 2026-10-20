import './style.css';
import { CabinPreview } from './scene';

const aboutSection = document.querySelector<HTMLElement>('#about');
if (aboutSection) {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    aboutSection.classList.add('is-visible');
  } else {
    const aboutObserver = new IntersectionObserver((entries, observer) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        aboutSection.classList.add('is-visible');
        observer.disconnect();
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -48px 0px' });
    aboutObserver.observe(aboutSection);
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) throw new Error('Three.js scene canvas was not found.');

const reducedMotionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const preview = new CabinPreview(canvas, reducedMotionPreference.matches);

const motionToggle = document.querySelector<HTMLButtonElement>('#motionToggle');
const snowToggle = document.querySelector<HTMLButtonElement>('#snowToggle');
const resetCamera = document.querySelector<HTMLButtonElement>('#resetCamera');
const rotateLeft = document.querySelector<HTMLButtonElement>('#rotateLeft');
const rotateRight = document.querySelector<HTMLButtonElement>('#rotateRight');
const zoomOut = document.querySelector<HTMLButtonElement>('#zoomOut');
const zoomIn = document.querySelector<HTMLButtonElement>('#zoomIn');
const watchAnimation = document.querySelector<HTMLButtonElement>('#watchAnimation');
const filmDialog = document.querySelector<HTMLDialogElement>('#filmDialog');
const closeFilm = document.querySelector<HTMLButtonElement>('#closeFilm');
const filmVideo = document.querySelector<HTMLVideoElement>('#filmVideo');

function refreshControls(): void {
  if (motionToggle) {
    const active = preview.isMotionEnabled;
    motionToggle.setAttribute('aria-pressed', String(active));
    motionToggle.setAttribute('aria-label', active ? 'Pause scene motion' : 'Play scene motion');
    const label = motionToggle.querySelector<HTMLElement>('.button-label');
    if (label) label.textContent = active ? 'PAUSE MOTION' : 'PLAY MOTION';
    const icon = motionToggle.querySelector<HTMLElement>('.control-icon');
    if (icon) icon.classList.toggle('is-playing', !active);
  }
  if (snowToggle) {
    const active = preview.isSnowEnabled;
    snowToggle.setAttribute('aria-pressed', String(active));
    snowToggle.setAttribute('aria-label', active ? 'Turn falling snow off' : 'Turn falling snow on');
    const label = snowToggle.querySelector<HTMLElement>('.button-label');
    if (label) label.textContent = active ? 'SNOW ON' : 'SNOW OFF';
  }
}

motionToggle?.addEventListener('click', () => {
  preview.setMotionEnabled(!preview.isMotionEnabled);
  refreshControls();
});

snowToggle?.addEventListener('click', () => {
  preview.setSnowEnabled(!preview.isSnowEnabled);
  refreshControls();
});

resetCamera?.addEventListener('click', () => preview.resetCamera());
rotateLeft?.addEventListener('click', () => preview.rotateCamera('left'));
rotateRight?.addEventListener('click', () => preview.rotateCamera('right'));
zoomOut?.addEventListener('click', () => preview.zoomCamera('out'));
zoomIn?.addEventListener('click', () => preview.zoomCamera('in'));

function openFilm(): void {
  if (!filmDialog || !filmVideo) return;
  filmDialog.showModal();
  void filmVideo.play().catch(() => {
    // Playback remains available through the visible native controls if autoplay is blocked.
  });
}

function dismissFilm(): void {
  if (!filmDialog || !filmVideo) return;
  filmVideo.pause();
  filmVideo.currentTime = 0;
  filmDialog.close();
}

watchAnimation?.addEventListener('click', openFilm);
closeFilm?.addEventListener('click', dismissFilm);
filmDialog?.addEventListener('click', (event) => {
  if (event.target === filmDialog) dismissFilm();
});
filmDialog?.addEventListener('close', () => {
  filmVideo?.pause();
});

reducedMotionPreference.addEventListener('change', (event) => {
  if (event.matches) {
    preview.setMotionEnabled(false);
    preview.setSnowEnabled(false);
  }
  refreshControls();
});

refreshControls();
