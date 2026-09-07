@echo off
title AI Knowledge Base Maintenance
echo Starting KB maintenance...
cd /d D:\DSH\workspace\knowledge-base
set PYTHONIOENCODING=utf-8
python maintain.py maintain
echo Maintenance completed.
pause
