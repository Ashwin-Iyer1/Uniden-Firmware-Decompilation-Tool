#!/usr/bin/env python3
"""Compatibility entry point; use rseries_unpack.py. Model support is unchanged."""
import runpy
from rseries_unpack import *  # Preserve existing public imports.

if __name__ == '__main__':
    runpy.run_module('rseries_unpack', run_name='__main__')
