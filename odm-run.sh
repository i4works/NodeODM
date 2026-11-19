#!/bin/bash
if [ -f /code/scripts/pixi-shell-hook ]; then
    source /code/scripts/pixi-shell-hook
elif [ -e /code/venv ]; then
    source /code/venv/bin/activate
fi
export LD_LIBRARY_PATH=$LD_LIBRARY_PATH:/code/SuperBuild/install/lib
export DYLD_LIBRARY_PATH=/code/SuperBuild/install/lib
exec python3 /code/run.py "$@"
