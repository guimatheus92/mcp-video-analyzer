import { describe, expect, it } from 'vitest';
import { envFlag, envInt } from './env.js';

describe('envFlag', () => {
  it.each(['1', 'true', 'TRUE', 'yes', 'on', ' on '])('treats %s as true', (value) => {
    expect(envFlag(value)).toBe(true);
  });

  it.each([undefined, '', '0', 'false', 'no', 'off', 'maybe'])('treats %s as false', (value) => {
    expect(envFlag(value)).toBe(false);
  });
});

describe('envInt', () => {
  it('parses plain digits', () => {
    expect(envInt('1280', 800)).toBe(1280);
    expect(envInt(' 0 ', 800)).toBe(0);
  });

  it('falls back when unset or blank', () => {
    expect(envInt(undefined, 800)).toBe(800);
    expect(envInt('', 800)).toBe(800);
    expect(envInt('   ', 800)).toBe(800);
  });

  it.each([
    ['-100', 'negative'],
    ['800.5', 'fractional'],
    ['abc', 'garbage'],
    ['Infinity', 'infinity'],
    ['NaN', 'nan'],
    ['12px', 'trailing unit'],
    ['+800', 'explicit sign'],
  ])('falls back on %s (%s)', (value) => {
    expect(envInt(value, 800)).toBe(800);
  });

  it.each([
    ['1e3', 'exponent notation would silently mean 1000'],
    ['0x20', 'hex would silently mean 32'],
  ])('falls back on %s — %s', (value) => {
    expect(envInt(value, 800)).toBe(800);
  });

  it('rejects values beyond safe-integer range rather than losing precision', () => {
    expect(envInt('99999999999999999999', 800)).toBe(800);
  });

  it('does not interpret word aliases — those belong to the setting that defines them', () => {
    // `native` means 0 only for a width cap; for a JPEG quality it means nothing.
    expect(envInt('native', 800)).toBe(800);
  });
});
