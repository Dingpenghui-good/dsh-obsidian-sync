# KB Hourly Maintenance
$env:PYTHONIOENCODING = "utf-8"
$kbRoot = "D:\DSH\workspace\knowledge-base"
python "$kbRoot\maintain.py" maintain 2>$null
