import { describe, expect, it } from 'vitest';
import { noteFontSize, noteHeight, noteIntersects, noteLineHeight, pageLayout } from './index';
import type { NoteMeta } from './index';
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
  it('keeps old notes readable and derives the larger font bounds for lazy loading', () => {
    const old: NoteMeta = {id:'old',anchorPage:1,x:-100,y:780,lineCount:3};
    expect(noteFontSize(old)).toBe(18);
    expect(noteLineHeight(old)).toBe(26);
    expect(noteHeight(old)).toBe(92);
    expect(noteIntersects(old,pages,950,1000)).toBe(false);
    expect(noteIntersects({...old,fontSize:36},pages,950,1000)).toBe(true);
    expect(noteFontSize({fontSize:0})).toBe(1);
    expect(noteFontSize({fontSize:Infinity})).toBe(18);
    expect(noteFontSize({fontSize:100})).toBe(72);
  });
});
