#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dsh_repo="${1:-${script_dir}/../deepseek-harness}"
patch_file="${script_dir}/integration/deepseek-harness.patch"

if [[ "$(git -C "${dsh_repo}" rev-parse --is-inside-work-tree 2>/dev/null)" != "true" ]]; then
  printf '未找到 DeepSeek Harness Git 仓库：%s\n' "${dsh_repo}" >&2
  exit 1
fi

if ! git -C "${dsh_repo}" apply --check "${patch_file}"; then
  printf '集成补丁无法直接应用。该补丁基于 DeepSeek Harness 477b4f420553e8a52c2fbccc464d7561b239c443；请检查目标仓库版本与现有修改。\n' >&2
  exit 1
fi

git -C "${dsh_repo}" apply "${patch_file}"
printf '已安装 DSH 会话“分析”标签页。接下来在 %s 构建并启动 DSH，再运行 npm start。\n' "${dsh_repo}"
