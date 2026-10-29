import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageLightboxComponent } from './image-lightbox.component';

describe('Image lightbox keyboard hints', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  function render() {
    TestBed.configureTestingModule({ imports: [ImageLightboxComponent] });
    const fixture = TestBed.createComponent(ImageLightboxComponent);
    fixture.componentRef.setInput('items', [
      { name: 'first attachment.txt', src: '', isImage: false },
      { name: 'second attachment.txt', src: '', isImage: false },
    ]);
    fixture.componentInstance.open(0);
    fixture.detectChanges();
    return fixture;
  }

  it('keeps navigation names distinct from their focus hints', () => {
    const fixture = render();
    const previous = fixture.nativeElement.querySelector('.lightbox-nav.prev') as HTMLButtonElement;
    expect(previous.getAttribute('aria-label')).toBe('Previous attachment');
    expect(previous.hasAttribute('title')).toBe(false);
    const matches = previous.matches.bind(previous);
    vi.spyOn(previous, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    previous.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent?.trim()).toBe('Previous');
    previous.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.currentIndex()).toBe(1);
  });

  it('handles arrow keys and Escape from controls inside the preview', () => {
    const fixture = render();
    const close = fixture.nativeElement.querySelector('.lightbox-close') as HTMLButtonElement;
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.currentIndex()).toBe(1);
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.currentIndex()).toBeNull();
    expect(fixture.nativeElement.querySelector('.lightbox-overlay')).toBeNull();
  });
});
