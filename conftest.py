# SPDX-License-Identifier: Apache-2.0
"""全量跑测试时的公共事：把插件模块的用户数据根钉在临时目录。

插件模块 import 期按 NEO_STUDIO_DATA 解析 gallery / recipes / configs 的落点，测试里
删目录、写配置的用例因此永远碰不到真实的 Neo-Studio/data 与 studio/ 里的用户数据。

pytest 收集 tests/ 里的用例时会导入名为 __init__ 的模块；目录名带连字符时它落空，
目录名是合法标识符后，sys.path 上的 studio/__init__.py 就被当成那个 __init__ 执行 ——
插件入口一跑就注册节点与路由，离线环境里 server / folder_paths 是桩，必炸。
这里用占位包顶住 studio 这个名字：__path__ 指向真目录，子模块照常按 studio.x 导入，
入口代码不执行。ComfyUI 加载的是 custom_nodes 下的副本，包名不同，不受影响。
"""
import atexit
import importlib.machinery
import os
import shutil
import sys
import tempfile
import types
from pathlib import Path

DATA_ROOT = tempfile.mkdtemp(prefix="neo_studio_test_data_")
os.environ["NEO_STUDIO_DATA"] = str(DATA_ROOT)
atexit.register(shutil.rmtree, DATA_ROOT, ignore_errors=True)

if "studio" not in sys.modules:
    _pkg = types.ModuleType("studio")
    _pkg.__path__ = [str(Path(__file__).resolve().parent / "studio")]
    _pkg.__spec__ = importlib.machinery.ModuleSpec("studio", None, is_package=True)
    sys.modules["studio"] = _pkg
