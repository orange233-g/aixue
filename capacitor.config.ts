import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.aixue.app',
  appName: 'ai学',
  webDir: 'dist',
  // Android 键盘「不压缩 WebView」由 AndroidManifest 里 activity 的
  // android:windowSoftInputMode="adjustPan" 控制（平移而非缩放页面）。
  // 注：@capacitor/keyboard 在 Android 端忽略 config 里的 resize:'none'，
  // 仅认 resizeOnFullScreen（布尔），故此处不配置该插件以免误导。
  plugins: {},
}

export default config
