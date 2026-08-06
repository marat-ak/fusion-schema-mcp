#!/bin/bash
mkdir -p /tmp/shard/png && rm -f /tmp/shard/png/*
cd /tmp/shard/out
for f in *.pdf; do pdftoppm -png -r 72 "$f" "/tmp/shard/png/${f%.pdf}"; done
cd /tmp/shard/out-extras
for f in *.pdf; do pdftoppm -png -r 72 "$f" "/tmp/shard/png/extra-${f%.pdf}"; done
ls /tmp/shard/png
