#!/usr/bin/env python3
"""Compatibility entry point; use rseries_iplink.py. Model support is unchanged."""
import runpy
from rseries_iplink import *  # Preserve existing public imports.

if __name__ == '__main__':
    runpy.run_module('rseries_iplink', run_name='__main__')
