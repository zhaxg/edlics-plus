// ui.mjs — bundles Preact + htm into ONE small ESM module (public/ui.mjs).
//
// Business code in public/js/*.mjs stays build-free: it imports `html`, `h`,
// `render`, hooks from this single prebuilt artifact. Only this bundle needs
// `npm run build` when the framework itself is upgraded.

import { h, Fragment, render, createContext } from 'preact';
import { createPortal } from 'preact/compat';
import { useState, useEffect, useRef, useMemo, useCallback, useContext } from 'preact/hooks';
import htm from 'htm';

// NOTE: this local name is what gets exported. Keep it distinct from htm's
// internal variables and always assert the export list in `npm run build`
// (see scripts/check-bundles.mjs) — minification can drop unused bindings.
const html = htm.bind(h);

export {
  h,
  Fragment,
  render,
  createContext,
  createPortal,
  html,
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useContext,
};
