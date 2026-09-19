FROM node:22-bookworm-slim

# 不装 apt 包以加快构建；全局安装 pnpm（对所有用户生效）
# 内网源 + 共享 store + 放行依赖 build script（沙箱内已隔离，安全）
RUN printf 'registry=https://mirrors.tencentyun.com/npm\nstore-dir=/pnpm-store\ndangerously-allow-all-builds=true\n' > /usr/local/etc/npmrc \
 && npm install -g pnpm@10

WORKDIR /workspace
