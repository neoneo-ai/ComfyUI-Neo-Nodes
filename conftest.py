# SPDX-License-Identifier: Apache-2.0
"""全量跑测试时的公共事：把插件模块的用户数据根钉在临时目录。

插件模块 import 期按 NEO_STUDIO_DATA 解析 gallery / recipes / configs 的落点，测试里
删目录、写配置的用例因此永远碰不到真实的 Neo-Studio/data 与 kernel-plugin 里的用户数据。
"""
import atexit
import os
import shutil
import tempfile

DATA_ROOT = tempfile.mkdtemp(prefix="neo_studio_test_data_")
os.environ["NEO_STUDIO_DATA"] = str(DATA_ROOT)
atexit.register(shutil.rmtree, DATA_ROOT, ignore_errors=True)
