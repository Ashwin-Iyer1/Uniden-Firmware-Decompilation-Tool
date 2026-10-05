#!/usr/bin/env python3
"""Compatibility entry point; use rseries_gfx.py. Model support is unchanged."""
import runpy
from rseries_gfx import *  # Preserve existing public imports.

if __name__ == '__main__':
    runpy.run_module('rseries_gfx', run_name='__main__')
