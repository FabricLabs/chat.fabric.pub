#!/bin/bash

set -e

dev=""
if [ "$1" = '-d' ]; then
    dev=":dev"
fi

if [ -n "$DIST_VERSION" ]; then
    version=$DIST_VERSION
else
    version=`git describe --dirty --tags || echo unknown`
fi

npm run clean
npm run build$dev

# include the sample config in the tarball. Arguably this should be done by
# `npm run build`, but it's just too painful.
cp config.sample.json webapp/

mkdir -p dist
cp -r webapp verse-$version

# if $version looks like semver with leading v, strip it before writing to file
if [[ ${version} =~ ^v[[:digit:]]+\.[[:digit:]]+\.[[:digit:]]+(-.+)?$ ]]; then
    echo ${version:1} > verse-$version/version
else
    echo ${version} > verse-$version/version
fi

tar chvzf dist/verse-$version.tar.gz verse-$version
rm -r verse-$version

echo
echo "Packaged dist/verse-$version.tar.gz"
