FROM node:22-bookworm-slim

# 不装 apt 包以加快构建；全局安装 pnpm（对所有用户生效）
# 内网源 + 共享 store + 放行依赖 build script（沙箱内已隔离，安全）
RUN printf 'registry=https://mirrors.tencentyun.com/npm\nstore-dir=/pnpm-store\ndangerously-allow-all-builds=true\nconfirm-modules-purge=false\n' > /usr/local/etc/npmrc \
 && npm install -g pnpm@10

# 技能依赖（npm CLI）装在共享卷 /pnpm-store/npm-global；
# 容器以非 root 运行，且 sh 是 dash（login shell 会重置 PATH），
# 所以显式在 profile.d 里把该 bin 前置，保证 `sh -lc <cmd>` 能找到它们。
RUN printf 'export PATH=/pnpm-store/npm-global/bin:$PATH\n' > /etc/profile.d/atoms-deps.sh \
 && chmod 0644 /etc/profile.d/atoms-deps.sh

WORKDIR /workspace
