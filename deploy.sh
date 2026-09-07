#!/bin/bash
cd ~/Desktop/culinara
if [ ! -d .git ]; then
  echo "No git repo found — setting one up..."
  git init
  git remote add origin https://github.com/officialhouseofprime/culinara.git
  git branch -M main
fi
git add .
echo ""
echo "=== Files about to be committed ==="
git status
echo ""
read -p "Commit message: " msg
git commit -m "$msg"
git push -u origin main || git push -u origin main --force
