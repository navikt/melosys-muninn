.PHONY: help deploy deploy-sjekk

# Målene tar ingen ref. En bestemt ref gis som argument til skriptet.
#
# En REF med innhold på kommandolinjen, i miljøet eller fra `make -e` stopper
# make før noe kjører. `$(value …)` gjør at verdien ikke ekspanderes her. Make
# 3.81 har to unntak som ikke kan stoppes fra Makefile: en REF i MAKEFLAGS
# ekspanderes allerede når make leser den (og stopper bare om resultatet har
# innhold), og `override REF=…` på kommandolinjen ignoreres og gir tuppen av main.
ifneq ($(value REF),)
$(error make-målene deployer alltid tuppen av muninn main og tar ingen REF. For en bestemt ref: scripts/deploy.sh <tag|sha>. Er REF eksportert fra annet arbeid: unset REF)
endif

# `make deploy <sha>` gjør <sha> til et mål nummer to. make ville deployet
# main først og feilet på <sha> etterpå, så ukjente mål stopper før noe kjører.
UKJENTE_MAL := $(filter-out help deploy deploy-sjekk,$(MAKECMDGOALS))
ifneq ($(UKJENTE_MAL),)
$(error ukjent mål: $(UKJENTE_MAL). make-målene tar ingen ref. For en bestemt ref: scripts/deploy.sh <tag|sha>)
endif

help:
	@echo "make deploy         deployer tuppen av muninn main til prod-gcp"
	@echo "make deploy-sjekk   bare forhåndssjekkene, starter ingen workflow"
	@echo "scripts/deploy.sh <tag|sha>            deployer en bestemt ref"
	@echo "DRY_RUN=1 scripts/deploy.sh <tag|sha>  sjekker en bestemt ref"

deploy:
	@scripts/deploy.sh

deploy-sjekk:
	@DRY_RUN=1 scripts/deploy.sh
