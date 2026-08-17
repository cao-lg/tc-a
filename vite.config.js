import { defineConfig } from 'vite'

// 老师本地工具：纯前端、本地运行（localhost 下 Web Crypto 可用）。
// 私钥/激活码只在本机 tools/ 目录，绝不进前端打包、绝不联网上传。
export default defineConfig({
  plugins: [],
  server: { host: true, port: 5178, strictPort: false },
  preview: { host: true, port: 4178 }
})
