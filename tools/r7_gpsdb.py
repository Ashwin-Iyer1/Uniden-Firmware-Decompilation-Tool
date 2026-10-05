#!/usr/bin/env python3
"""Compatibility entry point; use rseries_gpsdb.py. Model support is unchanged."""
import runpy
from rseries_gpsdb import *  # Preserve existing public imports.

if __name__ == '__main__':
    runpy.run_module('rseries_gpsdb', run_name='__main__')
