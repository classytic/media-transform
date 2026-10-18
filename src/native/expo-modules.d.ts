/**
 * Compile-time shims for the OPTIONAL Expo peers.
 *
 * They are not devDependencies (each drags in `expo` + `react-native`), so the
 * compiler only needs to know the specifiers exist. The shapes this package
 * relies on are declared structurally in `expoModules.ts` and checked by the
 * tests; nothing here is emitted into `dist`.
 */
declare module 'expo-image-manipulator';
declare module 'expo-file-system';
declare module 'expo-crypto';
