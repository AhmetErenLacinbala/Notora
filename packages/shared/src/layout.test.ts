import { describe, expect, it } from 'vitest';
import { noteIntersects, pageLayout } from './index';
describe('cross-page note geometry', () => {
  const pages = pageLayout([{number: 1,width:595,height:842},{number:2,width:842,height:595}]);
  it('positions pages before any PDF is loaded', () => {
    expect(pages[0].y).toBe(28);
    expect(pages[1].y).toBe(898);
    expect(pages[0].x - pages[1].x).toBe(123.5);
  });
  it('keeps a note from a previous page visible after the PDF page is evicted', () => {
    const note = {id:'a',anchorPage:1,x:-200,y:820,lineCount:10};
    expect(noteIntersects(note,pages,pages[1].y,pages[1].y+100)).toBe(true);
    expect(noteIntersects(note,pages,1600,1700)).toBe(false);
  });
});
