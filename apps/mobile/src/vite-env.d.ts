/// <reference types="vite/client" />

/**
 * 由 vite.config.ts 的 define 在构建期替换成 package.json 里的版本号。
 * 设置页的「关于」用它,避免手写常量和真实版本分叉。
 */
declare const __APP_VERSION__: string;
