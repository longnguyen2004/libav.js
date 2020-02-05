FFMPEG_VERSION=4.1.5

ffmpeg-$(FFMPEG_VERSION)/build-%/ffmpeg: ffmpeg-$(FFMPEG_VERSION)/build-%/ffbuild/config.mak
	cd ffmpeg-$(FFMPEG_VERSION)/build-$* ; emmake $(MAKE)

ffmpeg-$(FFMPEG_VERSION)/build-%/ffbuild/config.mak: ffmpeg-$(FFMPEG_VERSION)/configure configs/%/ffmpeg-config.txt
	test ! -e configs/$*/deps.txt || $(MAKE) `cat configs/$*/deps.txt`
	mkdir -p ffmpeg-$(FFMPEG_VERSION)/build-$* ; \
	cd ffmpeg-$(FFMPEG_VERSION)/build-$* ; \
	emconfigure env PKG_CONFIG_PATH="$(PWD)/tmp-inst/lib/pkgconfig" \
		../configure --prefix=/opt/ffmpeg --cc=emcc \
		--extra-cflags="-I$(PWD)/tmp-inst/include" \
		--extra-ldflags="-L$(PWD)/tmp-inst/lib" \
		--arch=emscripten --enable-small --disable-doc \
		--disable-stripping --disable-sdl2 \
		--disable-everything \
		`cat ../../configs/$*/ffmpeg-config.txt`

ffmpeg-$(FFMPEG_VERSION)/configure: ffmpeg-$(FFMPEG_VERSION).tar.xz
	tar Jxf ffmpeg-$(FFMPEG_VERSION).tar.xz
	touch ffmpeg-$(FFMPEG_VERSION)/configure

ffmpeg-$(FFMPEG_VERSION).tar.xz:
	curl https://ffmpeg.org/releases/ffmpeg-$(FFMPEG_VERSION).tar.xz -o $@
